// tools/tool_executor.js — Tool dispatch + safety checks
// Adopted from Meridian tools/executor.js pattern
// Maps agent tool_call names → actual implementation functions

import { screenPools, getActiveBinPrice, getPoolMeta } from "./dlmm.js";
import { simulateArbRoute, getTokenPrice, MINT_ADDRESSES } from "./jupiter.js";
import { getWalletStatus } from "./wallet.js";
import { state } from "../state.js";
import { executeArb } from "../executor.js";
import CONFIG from "../config.js";
import logger from "../logger.js";

// ── screen_pools ─────────────────────────────────────────────
async function tool_screen_pools({ limit = 20, min_tvl, sort_by = "volume" } = {}) {
  const minTvl = min_tvl ?? CONFIG.minTvl;
  const pools  = await screenPools({ minTvl, limit: Math.min(limit, 50), sortBy: sort_by });

  return pools.map(p => ({
    address:   p.address,
    name:      p.name,
    tvl:       p.tvl,
    volume24h: p.volume24h,
    fee24h:    p.fee24h,
    binStep:   p.binStep,
    mintX:     p.mintX,
    mintY:     p.mintY,
    feeToTvlRatio: p.tvl > 0 ? (p.fee24h / p.tvl) : 0,
  }));
}

// ── get_pool_price ────────────────────────────────────────────
async function tool_get_pool_price({ pool_address }) {
  if (!pool_address) throw new Error("pool_address required");

  const [price, meta] = await Promise.all([
    getActiveBinPrice(pool_address).catch(() => null),
    getPoolMeta(pool_address).catch(() => null),
  ]);

  return {
    address: pool_address,
    price:   price?.price ?? null,
    binId:   price?.binId ?? null,
    tvl:     meta?.tvl ?? null,
    name:    meta?.name ?? pool_address.slice(0, 8) + "...",
    baseFee: meta?.baseFeeRate ?? null,
  };
}

// ── simulate_route ────────────────────────────────────────────
async function tool_simulate_route({ tokens, input_amount_usdc }) {
  if (!tokens || tokens.length < 2) throw new Error("tokens array must have at least 2 elements");

  const inputUsdc = input_amount_usdc ?? CONFIG.inputAmountUsdc;

  // Resolve token symbols to mint addresses
  const resolvedTokens = tokens.map(t => {
    // If already looks like a base58 address (len > 20), use as-is
    if (t.length > 20) return t;
    // Otherwise look up in known mints
    if (!MINT_ADDRESSES[t]) throw new Error(`Unknown token symbol: ${t}. Use mint address instead.`);
    return t; // simulateArbRoute will resolve via MINT_ADDRESSES
  });

  const route = {
    name:   resolvedTokens.join("→"),
    tokens: resolvedTokens,
    hops:   resolvedTokens.length - 1,
  };

  const result = await simulateArbRoute(route, inputUsdc);
  if (!result) return { error: "Could not get quotes for this route — pool may be illiquid or token unknown to Jupiter" };

  return {
    routeName:      result.routeName,
    inputUsdc:      result.inputUsdc,
    outputUsdc:     result.outputUsdc,
    profitUsdc:     result.profitUsdc,
    roiMultiplier:  result.roiMultiplier,
    profitable:     result.profitable,
    legs: result.legs.map(l => ({
      from:        l.from,
      to:          l.to,
      priceImpact: l.priceImpact,
    })),
  };
}

// ── get_token_info ────────────────────────────────────────────
async function tool_get_token_info({ mint_address }) {
  if (!mint_address) throw new Error("mint_address required");

  try {
    // Jupiter token info API
    const resp = await fetch(
      `https://tokens.jup.ag/token/${mint_address}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!resp.ok) return { mint: mint_address, error: "Token not found on Jupiter", warning: "Unknown token — treat as high risk" };

    const data = await resp.json();
    const price = await getTokenPrice(mint_address);

    return {
      mint:        mint_address,
      symbol:      data.symbol || "UNKNOWN",
      name:        data.name || "Unknown",
      decimals:    data.decimals,
      price_usd:   price,
      tags:        data.tags || [],
      verified:    data.tags?.includes("verified") || false,
      strict_list: data.tags?.includes("strict") || false,
      warning:     !data.tags?.includes("verified") ? "Token not verified — increased risk" : null,
    };
  } catch (e) {
    return { mint: mint_address, error: e.message, warning: "Could not fetch token info — treat as high risk" };
  }
}

// ── get_wallet_status ─────────────────────────────────────────
async function tool_get_wallet_status() {
  const w = await getWalletStatus();
  return {
    address: w.address,
    sol:     w.sol,
    usdc:    w.usdc,
    hasEnoughSol:  w.sol >= 0.005,
    hasEnoughUsdc: w.usdc >= CONFIG.inputAmountUsdc,
  };
}

// ── get_execution_history ─────────────────────────────────────
async function tool_get_execution_history({ limit = 10 } = {}) {
  const summary = state.summary();
  const history = state.getProfitableHistory(0).slice(0, limit);

  return {
    summary,
    recent: history.map(h => ({
      at:      h.at,
      success: h.success,
      profit:  h.profit,
      route:   h.routeName,
      bundleId: h.bundleId,
    })),
  };
}

// ── compare_pool_prices ───────────────────────────────────────
async function tool_compare_pool_prices({ pool_addresses }) {
  if (!pool_addresses?.length) throw new Error("pool_addresses required");

  const results = await Promise.allSettled(
    pool_addresses.map(addr => tool_get_pool_price({ pool_address: addr }))
  );

  const prices = results
    .map((r, i) => r.status === "fulfilled"
      ? { ...r.value, poolAddress: pool_addresses[i] }
      : { poolAddress: pool_addresses[i], error: r.reason?.message }
    )
    .filter(p => p.price != null);

  if (prices.length < 2) return { prices, discrepancy: null, arbSignal: false };

  const sorted   = [...prices].sort((a, b) => b.price - a.price);
  const highest  = sorted[0];
  const lowest   = sorted[sorted.length - 1];
  const discrepancyPct = ((highest.price - lowest.price) / lowest.price) * 100;

  return {
    prices,
    highest:         { pool: highest.name || highest.poolAddress, price: highest.price },
    lowest:          { pool: lowest.name  || lowest.poolAddress,  price: lowest.price },
    discrepancyPct:  discrepancyPct.toFixed(2),
    arbSignal:       discrepancyPct > 5,  // flag if >5% gap
    suggestion:      discrepancyPct > 5
      ? `Buy on ${lowest.name || lowest.poolAddress} (cheaper), sell on ${highest.name || highest.poolAddress} (pricier)`
      : "No significant price gap detected",
  };
}

// ── execute_arb ───────────────────────────────────────────────
async function tool_execute_arb({ tokens, input_amount_usdc, reason }) {
  if (!tokens || tokens.length < 2) throw new Error("tokens required");

  logger.exec(`[AGENT→EXEC] Route: ${tokens.join("→")} | Reason: ${reason}`);

  // First simulate to get live opportunity object
  const inputUsdc = input_amount_usdc ?? CONFIG.inputAmountUsdc;
  const route     = { name: tokens.join("→"), tokens, hops: tokens.length - 1 };
  const sim       = await simulateArbRoute(route, inputUsdc);

  if (!sim) return { success: false, error: "Simulation failed — cannot execute without valid quote" };
  if (!sim.profitable) return { success: false, error: `Route not profitable: output $${sim.outputUsdc.toFixed(4)} < input $${inputUsdc}` };
  if (sim.profitUsdc < CONFIG.minProfitUsd * 0.5) {
    return { success: false, error: `Profit $${sim.profitUsdc.toFixed(2)} too low (min $${CONFIG.minProfitUsd * 0.5})` };
  }

  const result = await executeArb(sim);
  if (result) {
    state.recordExec({ ...result, routeName: route.name, agentReason: reason });
  }

  return result || { success: false, error: "Executor returned null" };
}

// ── Main dispatch ─────────────────────────────────────────────
export async function dispatchTool(name, args) {
  logger.dim(`[TOOL] ${name}(${JSON.stringify(args).slice(0, 80)}...)`);

  const dispatch = {
    screen_pools:        tool_screen_pools,
    get_pool_price:      tool_get_pool_price,
    simulate_route:      tool_simulate_route,
    get_token_info:      tool_get_token_info,
    get_wallet_status:   tool_get_wallet_status,
    get_execution_history: tool_get_execution_history,
    compare_pool_prices: tool_compare_pool_prices,
    execute_arb:         tool_execute_arb,
  };

  const fn = dispatch[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);

  try {
    const result = await fn(args);
    logger.dim(`[TOOL] ${name} → ${JSON.stringify(result).slice(0, 120)}...`);
    return result;
  } catch (e) {
    logger.error(`[TOOL] ${name} error: ${e.message}`);
    return { error: e.message };
  }
}
