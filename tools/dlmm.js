// tools/dlmm.js — Meteora DLMM REST API wrapper
// Replaced SDK (@meteora-ag/dlmm) with direct HTTP calls to Meteora API
// Reason: SDK incompatible with Node.js v22+ ESM (@coral-xyz/anchor dir import issue)

import axios from "axios";
import logger from "../logger.js";
import CONFIG from "../config.js";

const METEORA_API  = "https://dlmm-api.meteora.ag";
const METEORA_API2 = "https://app.meteora.ag/clmm-api";

// ── Get pool metadata ─────────────────────────────────────────
export async function getPoolMeta(poolAddress) {
  try {
    const resp = await axios.get(`${METEORA_API}/pair/${poolAddress}`, { timeout: 5000 });
    const d    = resp.data;
    return {
      address:      d.address,
      name:         d.name,
      tvl:          parseFloat(d.liquidity    || 0),
      volume24h:    parseFloat(d.trade_volume_24h || 0),
      fee24h:       parseFloat(d.fees_24h     || 0),
      baseFeeRate:  parseFloat(d.base_fee_percentage || 0) / 100,
      binStep:      d.bin_step || 0,
      mintX:        d.mint_x,
      mintY:        d.mint_y,
      organicScore: d.organic_volume_score || 0,
    };
  } catch (e) {
    logger.error(`getPoolMeta(${poolAddress.slice(0,8)}): ${e.message}`);
    return null;
  }
}

// ── Get active bin price via Meteora API ──────────────────────
export async function getActiveBinPrice(poolAddress) {
  try {
    const resp = await axios.get(`${METEORA_API}/pair/${poolAddress}`, { timeout: 5000 });
    const d    = resp.data;

    // current_price is in Meteora API response
    const price = parseFloat(d.current_price || d.price || 0);
    return {
      price,
      binId:    d.active_bin_id || null,
      rawPrice: price,
    };
  } catch (e) {
    logger.error(`getActiveBinPrice(${poolAddress.slice(0,8)}): ${e.message}`);
    return null;
  }
}

// ── Screen pools from Meteora API ─────────────────────────────
export async function screenPools({ minTvl = 5000, limit = 50, sortBy = "volume" } = {}) {
  try {
    const sortKey = sortBy === "volume" ? "trade_volume_24h"
                  : sortBy === "fee"    ? "fees_24h"
                  : "liquidity";

    const resp = await axios.get(
      `${METEORA_API}/pair/all_with_pagination?sort_key=${sortKey}&order_by=desc&limit=${limit}&offset=0`,
      { timeout: 8000 }
    );

    const pairs = Array.isArray(resp.data)
      ? resp.data
      : (resp.data?.data || resp.data?.pairs || []);

    return pairs
      .filter(p => parseFloat(p.liquidity || 0) >= minTvl)
      .map(p => ({
        address:   p.address,
        name:      p.name,
        tvl:       parseFloat(p.liquidity        || 0),
        volume24h: parseFloat(p.trade_volume_24h || 0),
        fee24h:    parseFloat(p.fees_24h         || 0),
        binStep:   p.bin_step,
        mintX:     p.mint_x,
        mintY:     p.mint_y,
      }));
  } catch (e) {
    logger.error(`screenPools: ${e.message}`);
    // Fallback: try alternate endpoint
    return await screenPoolsFallback({ minTvl, limit });
  }
}

// ── Fallback pool screener ────────────────────────────────────
async function screenPoolsFallback({ minTvl, limit }) {
  try {
    const resp = await axios.get(
      `${METEORA_API}/pair/all?limit=${limit}&sort_key=trade_volume_24h&order_by=desc`,
      { timeout: 8000 }
    );

    const pairs = Array.isArray(resp.data) ? resp.data : (resp.data?.data || []);

    return pairs
      .filter(p => parseFloat(p.liquidity || 0) >= minTvl)
      .slice(0, limit)
      .map(p => ({
        address:   p.address,
        name:      p.name || `${p.mint_x?.slice(0,4)}-${p.mint_y?.slice(0,4)}`,
        tvl:       parseFloat(p.liquidity        || 0),
        volume24h: parseFloat(p.trade_volume_24h || 0),
        fee24h:    parseFloat(p.fees_24h         || 0),
        binStep:   p.bin_step,
        mintX:     p.mint_x,
        mintY:     p.mint_y,
      }));
  } catch (e) {
    logger.error(`screenPoolsFallback: ${e.message}`);
    return [];
  }
}

// ── Simulate DLMM swap (via Meteora quote API) ────────────────
export async function simulateDlmmSwap(poolAddress, inputMint, inputAmountRaw, slippageBps = 100) {
  try {
    const resp = await axios.get(
      `${METEORA_API}/pair/${poolAddress}/quote`,
      {
        params: {
          input_mint:   inputMint,
          in_amount:    inputAmountRaw.toString(),
          slippage_bps: slippageBps,
        },
        timeout: 5000,
      }
    );

    const d = resp.data;
    return {
      inputAmount:  Number(d.in_amount  || inputAmountRaw),
      outputAmount: Number(d.out_amount || 0),
      minOutput:    Number(d.min_out_amount || 0),
      priceImpact:  parseFloat(d.price_impact || 0),
      fee:          Number(d.fee || 0),
    };
  } catch (e) {
    logger.error(`simulateDlmmSwap: ${e.message}`);
    return null;
  }
}
