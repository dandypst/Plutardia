// tools/dlmm.js — Meteora DLMM REST API wrapper (no SDK)
// Base URL: https://dlmm.datapi.meteora.ag
// Field mapping based on actual API response structure

import axios from "axios";
import logger from "../logger.js";

const BASE = "https://dlmm.datapi.meteora.ag";

// ── Screen pools ──────────────────────────────────────────────
export async function screenPools({ minTvl = 5000, limit = 100, sortBy = "volume" } = {}) {
  try {
    const resp = await axios.get(`${BASE}/pools`, {
      params: {
        page_size: Math.min(limit, 100), // API uses page_size not limit
        page:      1,
        sort_key:  sortBy === "fee" ? "fee" : "volume", // API sort keys
        order_by:  "desc",
      },
      timeout: 10000,
    });

    // Response shape: { total, pages, current_page, page_size, data: [...] }
    const raw = resp.data?.data || [];

    const pools = raw
      .filter(p => parseFloat(p.tvl || 0) >= minTvl)
      .map(normPool);

    logger.dim(`screenPools: ${pools.length} pools (TVL≥$${minTvl}) from ${raw.length} returned`);
    return pools;
  } catch (e) {
    logger.error(`screenPools: ${e.message}`);
    return [];
  }
}

// ── Normalize pool — maps actual API fields ───────────────────
function normPool(p) {
  return {
    address:   p.address || "",
    name:      p.name    || "unknown",
    tvl:       parseFloat(p.tvl || 0),
    volume24h: parseFloat(p.volume?.["24h"] || p.trade_volume_24h || 0),
    fee24h:    parseFloat(p.fee?.["24h"]    || p.fees_24h         || 0),
    binStep:   p.pool_config?.bin_step || p.bin_step || 0,
    // IMPORTANT: token info is nested under token_x / token_y
    mintX:     p.token_x?.address || p.mint_x || "",
    mintY:     p.token_y?.address || p.mint_y || "",
    symbolX:   p.token_x?.symbol  || "",
    symbolY:   p.token_y?.symbol  || "",
    decimalsX: p.token_x?.decimals ?? 9,
    decimalsY: p.token_y?.decimals ?? 6,
    verifiedX: p.token_x?.is_verified || false,
    verifiedY: p.token_y?.is_verified || false,
    priceX:    parseFloat(p.token_x?.price || 0),
    priceY:    parseFloat(p.token_y?.price || 0),
    currentPrice: parseFloat(p.current_price || 0),
  };
}

// ── Get single pool metadata ──────────────────────────────────
export async function getPoolMeta(poolAddress) {
  try {
    const resp = await axios.get(`${BASE}/pools/${poolAddress}`, { timeout: 5000 });
    return normPool(resp.data);
  } catch (e) {
    logger.error(`getPoolMeta(${poolAddress.slice(0, 8)}): ${e.message}`);
    return null;
  }
}

// ── Get active bin price ──────────────────────────────────────
export async function getActiveBinPrice(poolAddress) {
  const meta = await getPoolMeta(poolAddress);
  if (!meta) return null;
  return {
    price:    meta.currentPrice,
    binId:    null,
    rawPrice: meta.currentPrice,
  };
}

// ── Simulate DLMM swap ────────────────────────────────────────
export async function simulateDlmmSwap(poolAddress, inputMint, inputAmountRaw, slippageBps = 100) {
  try {
    const resp = await axios.get(`${BASE}/pools/${poolAddress}/quote`, {
      params: { input_mint: inputMint, in_amount: inputAmountRaw.toString(), slippage_bps: slippageBps },
      timeout: 5000,
    });
    const d = resp.data;
    return {
      inputAmount:  Number(d.in_amount      || inputAmountRaw),
      outputAmount: Number(d.out_amount      || 0),
      minOutput:    Number(d.min_out_amount  || 0),
      priceImpact:  parseFloat(d.price_impact || 0),
      fee:          Number(d.fee             || 0),
    };
  } catch (e) {
    logger.error(`simulateDlmmSwap: ${e.message}`);
    return null;
  }
}
