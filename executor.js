// executor.js — Arbitrage executor
// Builds multi-hop swap txs, applies slippage protection, sends via Jito bundle

import {
  VersionedTransaction,
  Transaction,
  PublicKey,
  TransactionMessage,
  VersionedMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getKeypair, getConnection, getSolBalance, getTokenBalance } from "./tools/wallet.js";
import { getJupiterQuote, getJupiterSwapTx, MINT_ADDRESSES } from "./tools/jupiter.js";
import { sendJitoBundle, waitForBundle, buildTipInstruction } from "./tools/jito.js";
import { FlashLoan } from "./tools/flashloan.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

// Execution stats
let _execCount    = 0;
let _successCount = 0;
let _totalProfit  = 0;
let _isExecuting  = false;

// ── Slippage protection check ────────────────────────────────
function checkSlippage(expectedOut, actualOut) {
  const slippage = Math.abs((actualOut - expectedOut) / expectedOut) * 100;
  if (slippage > CONFIG.maxSlippagePct) {
    throw new Error(
      `Slippage too high: ${slippage.toFixed(2)}% > max ${CONFIG.maxSlippagePct}%`
    );
  }
  return slippage;
}

// ── Build all swap legs via Jupiter ──────────────────────────
async function buildSwapLegs(route, inputAmountUsdc, walletPubkey) {
  const legs      = [];
  let currentMint = MINT_ADDRESSES.USDC;
  let currentAmt  = Math.floor(inputAmountUsdc * 1e6);

  for (let i = 0; i < route.tokens.length - 1; i++) {
    const fromToken = route.tokens[i];
    const toToken   = route.tokens[i + 1];
    const fromMint  = MINT_ADDRESSES[fromToken] || fromToken;
    const toMint    = MINT_ADDRESSES[toToken]   || toToken;

    logger.exec(`  Leg ${i + 1}: ${fromToken} → ${toToken} (${currentAmt} raw)`);

    const quote = await getJupiterQuote({
      inputMint:   fromMint,
      outputMint:  toMint,
      amount:      currentAmt,
      slippageBps: Math.floor(CONFIG.maxSlippagePct * 100),
    });

    if (!quote) throw new Error(`No quote for leg ${i + 1}: ${fromToken}→${toToken}`);

    const swapTxBase64 = await getJupiterSwapTx(quote, walletPubkey);
    if (!swapTxBase64) throw new Error(`No swap tx for leg ${i + 1}`);

    legs.push({
      from:        fromToken,
      to:          toToken,
      inputAmount: currentAmt,
      outputAmount: quote.outputAmount,
      minOutput:    quote.minOutput,
      priceImpact:  quote.priceImpactPct,
      swapTxBase64,
      quote,
    });

    currentMint = toMint;
    currentAmt  = quote.outputAmount;
  }

  return legs;
}

// ── Main execute function ─────────────────────────────────────
export async function executeArb(opportunity) {
  if (_isExecuting) {
    logger.warn("Already executing — skipping concurrent execution");
    return null;
  }

  _isExecuting = true;
  _execCount++;

  const { routeName, inputUsdc, profitUsdc, roiMultiplier } = opportunity;
  logger.banner(`EXECUTING ARB #${_execCount}`);
  logger.exec(`Route:  ${routeName}`);
  logger.exec(`Input:  $${inputUsdc.toFixed(4)} USDC`);
  logger.exec(`Expect: $${(inputUsdc + profitUsdc).toFixed(2)} USDC out (${roiMultiplier.toFixed(0)}x ROI)`);

  try {
    const kp         = getKeypair();
    const connection = getConnection();
    const walletAddr = kp.publicKey.toBase58();

    // ── Pre-execution checks ──────────────────────────────────
    const sol  = await getSolBalance();
    const usdc = await getTokenBalance(MINT_ADDRESSES.USDC, walletAddr) / 1e6;

    if (sol < 0.005) throw new Error(`Insufficient SOL for fees: ${sol} SOL`);

    if (!CONFIG.useFlashLoan && usdc < inputUsdc) {
      throw new Error(`Insufficient USDC: have $${usdc.toFixed(2)}, need $${inputUsdc.toFixed(4)}`);
    }

    logger.exec(`Pre-check OK: SOL=${sol.toFixed(4)}, USDC=$${usdc.toFixed(2)}`);

    // ── Flash loan setup (optional) ───────────────────────────
    let flashLoan = null;
    if (CONFIG.useFlashLoan) {
      flashLoan = new FlashLoan({ amountUsdc: inputUsdc });
      const ok = await flashLoan.init();
      if (!ok) {
        logger.warn("Flash loan unavailable — using wallet USDC instead");
        flashLoan = null;
      }
    }

    // ── Find the route config ──────────────────────────────────
    let route = CONFIG.arbRoutes.find(r => r.name === routeName);
    if (!route) {
      // Reconstruct from simLegs: [leg0.from, leg0.to, leg1.to, ...]
      const simLegsData = opportunity.legs;
      if (!simLegsData || simLegsData.length === 0) {
        throw new Error("Cannot reconstruct route — no legs data and route not in config");
      }
      const tokens = [simLegsData[0].from, ...simLegsData.map(l => l.to)];
      route = { name: routeName, tokens };
    }

    if (!route.tokens || route.tokens.length < 2) {
      throw new Error("Cannot reconstruct route tokens");
    }

    // ── Build swap legs ───────────────────────────────────────
    logger.exec(`Building ${route.tokens.length - 1} swap legs...`);
    const legs = await buildSwapLegs(route, inputUsdc, walletAddr);

    // ── Verify final output before executing ──────────────────
    const finalOutputUsdc = legs[legs.length - 1].outputAmount / 1e6;
    const expectedOutput  = inputUsdc + profitUsdc;
    const slippage        = checkSlippage(expectedOutput, finalOutputUsdc);

    const netProfit = flashLoan
      ? flashLoan.netProfit(finalOutputUsdc - inputUsdc)
      : finalOutputUsdc - inputUsdc;

    if (netProfit < CONFIG.minProfitUsd * 0.5) {
      throw new Error(
        `Net profit $${netProfit.toFixed(2)} below threshold after slippage (${slippage.toFixed(2)}%)`
      );
    }

    logger.exec(`Slippage: ${slippage.toFixed(2)}% | Net profit: $${netProfit.toFixed(2)}`);

    // ── Deserialize and sign transactions ─────────────────────
    const signedTxs = [];

    for (let i = 0; i < legs.length; i++) {
      const leg      = legs[i];
      const txBuf    = Buffer.from(leg.swapTxBase64, "base64");
      const isLast   = i === legs.length - 1;

      let serialized;

      try {
        // Try VersionedTransaction first (Jupiter always returns versioned)
        const tx = VersionedTransaction.deserialize(txBuf);

        // For VersionedTransaction, Jito tip is sent as a separate last tx in the bundle
        // (VersionedTransaction does not support .add() — tip handled below outside loop)
        tx.sign([kp]);
        serialized = bs58.encode(tx.serialize());
      } catch {
        // Fall back to legacy Transaction
        const tx = Transaction.from(txBuf);
        if (isLast) {
          // Add Jito tip to the last legacy tx
          tx.add(buildTipInstruction(kp.publicKey));
        }
        tx.partialSign(kp);
        serialized = bs58.encode(tx.serialize());
      }

      signedTxs.push(serialized);
    }

    // ── Append standalone Jito tip tx for VersionedTransaction bundles ──
    // Jito accepts a separate tip transfer as the last tx in a bundle
    {
      const tipIx   = buildTipInstruction(kp.publicKey);
      const conn    = getConnection();
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tipMsg  = new TransactionMessage({
        payerKey:    kp.publicKey,
        recentBlockhash: blockhash,
        instructions: [tipIx],
      }).compileToV0Message();
      const tipTx   = new VersionedTransaction(tipMsg);
      tipTx.sign([kp]);
      signedTxs.push(bs58.encode(tipTx.serialize()));
    }

    logger.exec(`Signed ${signedTxs.length} transactions — sending Jito bundle...`);

    // ── Send bundle ───────────────────────────────────────────
    let bundleResult;
    if (CONFIG.dryRun) {
      logger.warn("[DRY RUN] Skipping actual bundle submission");
      bundleResult = { bundleId: "dry-" + Date.now(), confirmed: true, status: "dry_run" };
    } else {
      const { bundleId } = await sendJitoBundle(signedTxs);
      bundleResult = await waitForBundle(bundleId, CONFIG.execTimeoutMs);
      bundleResult.bundleId = bundleId;
    }

    if (bundleResult.confirmed || CONFIG.dryRun) {
      _successCount++;
      _totalProfit += netProfit;

      logger.success(`✅ ARB SUCCESS #${_execCount}`);
      logger.success(`   Bundle: ${bundleResult.bundleId}`);
      logger.success(`   Profit: $${netProfit.toFixed(2)} USDC`);
      logger.success(`   Total profit: $${_totalProfit.toFixed(2)} USDC`);

      return {
        success:   true,
        bundleId:  bundleResult.bundleId,
        profit:    netProfit,
        status:    bundleResult.status,
      };
    } else {
      throw new Error(`Bundle not confirmed: ${bundleResult.status}`);
    }

  } catch (e) {
    logger.error(`ARB FAILED #${_execCount}: ${e.message}`);
    return { success: false, error: e.message };
  } finally {
    _isExecuting = false;
  }
}

export function getExecStats() {
  return {
    total:       _execCount,
    success:     _successCount,
    failed:      _execCount - _successCount,
    totalProfit: _totalProfit,
    winRate:     _execCount > 0 ? (_successCount / _execCount * 100).toFixed(1) : "0.0",
    executing:   _isExecuting,
  };
}
