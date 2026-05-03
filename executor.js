// executor.js — Arbitrage executor
// Builds swap txs from simulation result, signs, sends via Jito bundle

import {
  VersionedTransaction,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import bs58 from "bs58";
import { getKeypair, getConnection, getSolBalance, getTokenBalance } from "./tools/wallet.js";
import { getJupiterQuote, getJupiterSwapTx } from "./tools/jupiter.js";
import { MINT_ADDRESSES, BASE_TOKENS } from "./tools/token_registry.js";
import { sendJitoBundle, waitForBundle, buildTipInstruction } from "./tools/jito.js";
import { FlashLoan } from "./tools/flashloan.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

let _execCount    = 0;
let _successCount = 0;
let _totalProfit  = 0;
let _isExecuting  = false;

// ── Slippage check ────────────────────────────────────────────
function checkSlippage(expected, actual) {
  const slippage = Math.abs((actual - expected) / expected) * 100;
  if (slippage > CONFIG.maxSlippagePct) {
    throw new Error(`Slippage ${slippage.toFixed(2)}% > max ${CONFIG.maxSlippagePct}%`);
  }
  return slippage;
}

// ── Re-quote all legs and build fresh swap txs ────────────────
async function buildSwapLegs(sim, walletPubkey) {
  const legs = [];

  for (let i = 0; i < sim.legs.length; i++) {
    const leg = sim.legs[i];

    logger.exec(`  Leg ${i + 1}: ${leg.from} → ${leg.to} (${leg.inputAmount} raw)`);

    const freshQuote = await getJupiterQuote({
      inputMint:   leg.fromMint || leg.from,
      outputMint:  leg.toMint   || leg.to,
      amount:      leg.inputAmount,
      slippageBps: Math.floor(CONFIG.maxSlippagePct * 100),
    });

    if (!freshQuote) throw new Error(`Re-quote failed: leg ${i + 1} ${leg.from}→${leg.to}`);

    const swapTxBase64 = await getJupiterSwapTx(freshQuote, walletPubkey);
    if (!swapTxBase64) throw new Error(`No swap tx: leg ${i + 1}`);

    legs.push({ ...leg, outputAmount: freshQuote.outputAmount, minOutput: freshQuote.minOutput, swapTxBase64, freshQuote });
  }

  return legs;
}

// ── Main execute ──────────────────────────────────────────────
export async function executeArb(opportunity) {
  if (_isExecuting) {
    logger.warn("Already executing — skipping");
    return null;
  }

  _isExecuting = true;
  _execCount++;

  const {
    routeName,
    inputAmount,   inputUsdc,    // inputAmount is canonical; inputUsdc is compat alias
    profitAmount,  profitUsdc,
    roiMultiplier,
    baseMint,
    legs: simLegs,
  } = opportunity;

  const input  = inputAmount  ?? inputUsdc  ?? CONFIG.inputAmountUsdc;
  const profit = profitAmount ?? profitUsdc ?? 0;

  // Determine base token decimals
  const baseInfo  = baseMint ? Object.values(BASE_TOKENS).find(b => b.mint === baseMint) : BASE_TOKENS.USDC;
  const decimals  = baseInfo?.decimals ?? 6;
  const baseSymbol = baseInfo?.symbol ?? "USDC";

  logger.banner(`EXECUTING ARB #${_execCount}`);
  logger.exec(`Route:   ${routeName}`);
  logger.exec(`Input:   ${input} ${baseSymbol}`);
  logger.exec(`Expect:  ${(input + profit).toFixed(6)} ${baseSymbol} out (${roiMultiplier?.toFixed(0)}x ROI)`);

  try {
    const kp         = getKeypair();
    const connection = getConnection();
    const walletAddr = kp.publicKey.toBase58();

    // ── Pre-checks ────────────────────────────────────────────
    const sol = await getSolBalance();
    if (sol < 0.005) throw new Error(`SOL too low: ${sol.toFixed(6)} (need ≥0.005)`);

    if (!CONFIG.useFlashLoan && baseSymbol === "USDC") {
      const usdcBal = await getTokenBalance(BASE_TOKENS.USDC.mint, walletAddr) / 1e6;
      if (usdcBal < input) throw new Error(`USDC too low: $${usdcBal.toFixed(2)} < $${input}`);
    }

    logger.exec(`Pre-check OK | SOL=${sol.toFixed(4)}`);

    // ── Flash loan ────────────────────────────────────────────
    let flashLoan = null;
    if (CONFIG.useFlashLoan && baseSymbol === "USDC") {
      flashLoan = new FlashLoan({ amountUsdc: input });
      const ok = await flashLoan.init();
      if (!ok) { logger.warn("Flash loan unavailable — using wallet funds"); flashLoan = null; }
    }

    // ── Validate legs exist ───────────────────────────────────
    if (!simLegs || simLegs.length === 0) {
      throw new Error("No legs in opportunity — run simulate first");
    }

    // ── Build fresh swap txs ──────────────────────────────────
    logger.exec(`Building ${simLegs.length} legs...`);
    const legs = await buildSwapLegs(opportunity, walletAddr);

    // ── Verify output ─────────────────────────────────────────
    const finalRaw = legs[legs.length - 1].outputAmount;
    const finalAmt = finalRaw / Math.pow(10, decimals);
    const slippage = checkSlippage(input + profit, finalAmt);
    const netProfit = flashLoan ? flashLoan.netProfit(finalAmt - input) : finalAmt - input;

    if (netProfit < CONFIG.minProfitUsd * 0.5) {
      throw new Error(`Net profit ${netProfit.toFixed(6)} too low after ${slippage.toFixed(2)}% slippage`);
    }

    logger.exec(`Slippage: ${slippage.toFixed(2)}% | Net: ${netProfit.toFixed(6)} ${baseSymbol}`);

    // ── Sign txs ──────────────────────────────────────────────
    const signedTxs = [];

    for (const leg of legs) {
      const txBuf = Buffer.from(leg.swapTxBase64, "base64");
      let serialized;
      try {
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([kp]);
        serialized = bs58.encode(tx.serialize());
      } catch {
        const tx = Transaction.from(txBuf);
        tx.partialSign(kp);
        serialized = bs58.encode(tx.serialize());
      }
      signedTxs.push(serialized);
    }

    // Append Jito tip as separate tx
    const tipIx  = buildTipInstruction(kp.publicKey);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const tipMsg = new TransactionMessage({
      payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [tipIx],
    }).compileToV0Message();
    const tipTx = new VersionedTransaction(tipMsg);
    tipTx.sign([kp]);
    signedTxs.push(bs58.encode(tipTx.serialize()));

    logger.exec(`Signed ${signedTxs.length} txs — sending Jito bundle...`);

    // ── Send bundle ───────────────────────────────────────────
    let bundleResult;
    if (CONFIG.dryRun) {
      logger.warn("[DRY RUN] Bundle not sent");
      bundleResult = { bundleId: "dry-" + Date.now(), confirmed: true, status: "dry_run" };
    } else {
      const { bundleId } = await sendJitoBundle(signedTxs);
      bundleResult = await waitForBundle(bundleId, CONFIG.execTimeoutMs);
      bundleResult.bundleId = bundleId;
    }

    if (bundleResult.confirmed || CONFIG.dryRun) {
      _successCount++;
      _totalProfit += netProfit;

      logger.success(`✅ ARB SUCCESS #${_execCount} | bundle: ${bundleResult.bundleId}`);
      logger.success(`   Profit: ${netProfit.toFixed(6)} ${baseSymbol} | Total: ${_totalProfit.toFixed(4)}`);

      return { success: true, bundleId: bundleResult.bundleId, profit: netProfit, status: bundleResult.status };
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
