// tools/dlmm.js — Meteora DLMM REST API wrapper (no SDK)
// Base URL: https://dlmm.datapi.meteora.ag (per Meteora docs May 2026)
// Swagger: https://dlmm.datapi.meteora.ag/swagger-ui/

import axios from "axios";
import logger from "../logger.js";

const BASE = "https://dlmm.datapi.meteora.ag";

// ── Screen pools ──────────────────────────────────────────────
export async function screenPools({ minTvl = 5000, limit = 50, sortBy = "volume" } = {}) {
  try {
    const resp = await axios.get(`${BASE}/pools`, {
      params: {
        limit,
        sort_key:  sortBy === "volume" ? "trade_volume_24h"
                 : sortBy === "fee"    ? "fees_24h"
                 : "liquidity",
        order_by: "desc",
      },
      timeout: 10000,
    });

    const raw = Array.isArray(resp.data)
      ? resp.data
      : (resp.data?.data || resp.data?.pools || []);

    const pools = raw
      .filter(p => parseFloat(p.liquidity || p.tvl || 0) >= minTvl)
      .slice(0, limit)
      .map(normPool);

    logger.dim(`screenPools: ${pools.length} pools returned`);
    return pools;
  } catch (e) {
    logger.error(`screenPools: ${e.message}`);
    return [];
  }
}

// ── Normalize pool shape ──────────────────────────────────────
function normPool(p) {
  return {
    address:   p.address   || p.pubkey || "",
    name:      p.name      || `${(p.mint_x||"?").slice(0,4)}-${(p.mint_y||"?").slice(0,4)}`,
    tvl:       parseFloat(p.liquidity        || p.tvl       || 0),
    volume24h: parseFloat(p.trade_volume_24h || p.volume24h || 0),
    fee24h:    parseFloat(p.fees_24h         || p.fee24h    || 0),
    binStep:   p.bin_step  || p.binStep || 0,
    mintX:     p.mint_x    || p.tokenXMint || "",
    mintY:     p.mint_y    || p.tokenYMint || "",
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
  const price = parseFloat(meta.current_price || meta.price || 0);
  return { price, binId: meta.active_bin_id || null, rawPrice: price };
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
      inputAmount:  Number(d.in_amount         || inputAmountRaw),
      outputAmount: Number(d.out_amount         || 0),
      minOutput:    Number(d.min_out_amount      || 0),
      priceImpact:  parseFloat(d.price_impact    || 0),
      fee:          Number(d.fee                 || 0),
    };
  } catch (e) {
    logger.error(`simulateDlmmSwap: ${e.message}`);
    return null;
  }
}
