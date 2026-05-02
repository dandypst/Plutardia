// tools/dlmm.js — Meteora DLMM SDK wrapper
// Adopted from Meridian tools/dlmm.js pattern

import DLMM from "@meteora-ag/dlmm";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./wallet.js";
import logger from "../logger.js";
import BN from "bn.js";

// ── Get DLMM pool state ──────────────────────────────────────
export async function getDlmmPool(poolAddress) {
  const conn = getConnection();
  const pk   = new PublicKey(poolAddress);

  try {
    const dlmmPool = await DLMM.create(conn, pk);
    return dlmmPool;
  } catch (e) {
    logger.error(`getDlmmPool(${poolAddress.slice(0,8)}...): ${e.message}`);
    return null;
  }
}

// ── Get active bin price ─────────────────────────────────────
export async function getActiveBinPrice(poolAddress) {
  const pool = await getDlmmPool(poolAddress);
  if (!pool) return null;

  try {
    const activeBin = await pool.getActiveBin();
    const price     = pool.fromPricePerLamport(Number(activeBin.price));
    return {
      binId: activeBin.binId,
      price: parseFloat(price),
      rawPrice: activeBin.price,
    };
  } catch (e) {
    logger.error(`getActiveBinPrice: ${e.message}`);
    return null;
  }
}

// ── Simulate a DLMM swap to get expected output ──────────────
export async function simulateDlmmSwap(poolAddress, inputMint, inputAmountRaw, slippageBps = 100) {
  const pool = await getDlmmPool(poolAddress);
  if (!pool) return null;

  try {
    const inMintPk  = new PublicKey(inputMint);
    const swapForY  = pool.tokenX.publicKey.equals(inMintPk);
    const inAmount  = new BN(inputAmountRaw.toString());

    const binArrays = await pool.getBinArrayForSwap(swapForY);
    const quote     = await pool.swapQuote(inAmount, swapForY, new BN(slippageBps), binArrays);

    return {
      inputAmount:  Number(quote.consumedInAmount),
      outputAmount: Number(quote.outAmount),
      minOutput:    Number(quote.minOutAmount),
      priceImpact:  quote.priceImpact ? parseFloat(quote.priceImpact) : 0,
      fee:          Number(quote.fee),
    };
  } catch (e) {
    logger.error(`simulateDlmmSwap: ${e.message}`);
    return null;
  }
}

// ── Build DLMM swap transaction ──────────────────────────────
export async function buildDlmmSwapTx(poolAddress, userPk, inputMint, inputAmountRaw, minOutputRaw) {
  const pool = await getDlmmPool(poolAddress);
  if (!pool) throw new Error("Pool not found: " + poolAddress);

  const inMintPk = new PublicKey(inputMint);
  const swapForY = pool.tokenX.publicKey.equals(inMintPk);
  const inAmount = new BN(inputAmountRaw.toString());
  const minOut   = new BN(minOutputRaw.toString());

  const binArrays = await pool.getBinArrayForSwap(swapForY);

  const swapTx = await pool.swap({
    inToken:        inMintPk,
    binArraysPubkey: binArrays.map(b => b.publicKey),
    inAmount,
    lbPair:         pool.pubkey,
    user:           userPk,
    minOutAmount:   minOut,
    outToken:       swapForY ? pool.tokenY.publicKey : pool.tokenX.publicKey,
  });

  return swapTx;
}

// ── Get pool TVL and fee data (via Meteora API) ───────────────
export async function getPoolMeta(poolAddress) {
  try {
    const url  = `https://dlmm-api.meteora.ag/pair/${poolAddress}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      tvl:            parseFloat(data.liquidity || 0),
      volume24h:      parseFloat(data.trade_volume_24h || 0),
      fee24h:         parseFloat(data.fees_24h || 0),
      baseFeeRate:    parseFloat(data.base_fee_percentage || 0) / 100,
      organicScore:   data.organic_volume_score || 0,
      binStep:        data.bin_step || 0,
      name:           data.name || poolAddress,
    };
  } catch {
    return null;
  }
}

// ── Screen pools from Meteora API ────────────────────────────
export async function screenPools({ minTvl = 5000, limit = 20, sortBy = "volume" } = {}) {
  try {
    const url  = `https://dlmm-api.meteora.ag/pair/all?sort_key=${sortBy}&order_by=desc&limit=${limit}`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    const pairs = Array.isArray(data) ? data : (data.data || []);

    return pairs
      .filter(p => parseFloat(p.liquidity || 0) >= minTvl)
      .map(p => ({
        address:      p.address,
        name:         p.name,
        tvl:          parseFloat(p.liquidity || 0),
        volume24h:    parseFloat(p.trade_volume_24h || 0),
        fee24h:       parseFloat(p.fees_24h || 0),
        binStep:      p.bin_step,
        mintX:        p.mint_x,
        mintY:        p.mint_y,
      }));
  } catch (e) {
    logger.error(`screenPools: ${e.message}`);
    return [];
  }
}
