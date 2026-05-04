// tools/route_builder.js — Dynamic route builder
// Discovers ALL possible arb routes from live pool data
// No hardcoded routes — everything is built from on-chain pool screening

import { screenPools } from "./dlmm.js";
import { resolveMint, registerPoolTokens, BASE_TOKENS } from "./token_registry.js";
import { getJupiterQuote } from "./jupiter.js";
import CONFIG from "../config.js";
import logger from "../logger.js";

// ── Base token mints (start/end of arb routes) ────────────────
function getBaseMints() {
  const baseSymbols = CONFIG.baseTokens || ["USDC", "SOL"];
  return baseSymbols.map(s => BASE_TOKENS[s]).filter(Boolean);
}

// ── Discover all liquid token mints from Meteora pools ────────
export async function discoverLiquidTokens({ minTvl, limit = 100 } = {}) {
  const tvlThreshold = minTvl ?? CONFIG.minTvl;
  const pools = await screenPools({ minTvl: tvlThreshold, limit, sortBy: "volume" });

  // Register token metadata from pool data (no extra API call needed
  // because normPool() already extracts symbol, decimals, verified from token_x/token_y)
  await registerPoolTokens(pools);

  const baseMints = new Set(getBaseMints().map(b => b.mint));
  const midTokens = new Set();

  for (const pool of pools) {
    // mintX and mintY already normalized by normPool()
    if (pool.mintX && !baseMints.has(pool.mintX)) midTokens.add(pool.mintX);
    if (pool.mintY && !baseMints.has(pool.mintY)) midTokens.add(pool.mintY);
  }

  logger.dim(`Route builder: ${midTokens.size} mid-tokens discovered from ${pools.length} pools`);

  return {
    pools,
    baseMints: [...baseMints],
    midTokens: [...midTokens],
  };
}

// ── Build all possible routes up to maxHops ───────────────────
// Route structure: [baseMint, midToken1?, midToken2?, baseMint]
export function buildRoutes(baseMints, midTokens, maxHops) {
  const hops    = maxHops ?? CONFIG.maxHops ?? 3;
  const routes  = [];

  for (const base of baseMints) {
    // 2-hop: base → mid → base
    if (hops >= 2) {
      for (const mid of midTokens) {
        routes.push({
          tokens:   [base, mid, base],
          hops:     2,
          name:     `${_sym(base)}→${_sym(mid)}→${_sym(base)}`,
          baseMint: base,
        });
      }
    }

    // 3-hop: base → midA → midB → base
    if (hops >= 3) {
      // Limit 3-hop combos to avoid explosion: top 30 mid-tokens only
      const top = midTokens.slice(0, 30);
      for (let i = 0; i < top.length; i++) {
        for (let j = 0; j < top.length; j++) {
          if (i === j) continue;
          routes.push({
            tokens:   [base, top[i], top[j], base],
            hops:     3,
            name:     `${_sym(base)}→${_sym(top[i])}→${_sym(top[j])}→${_sym(base)}`,
            baseMint: base,
          });
        }
      }
    }

    // 4-hop: base → A → B → C → base
    if (hops >= 4) {
      const top = midTokens.slice(0, 10); // strict limit for 4-hop
      for (let i = 0; i < top.length; i++) {
        for (let j = 0; j < top.length; j++) {
          for (let k = 0; k < top.length; k++) {
            if (i === j || j === k || i === k) continue;
            routes.push({
              tokens:   [base, top[i], top[j], top[k], base],
              hops:     4,
              name:     `${_sym(base)}→${_sym(top[i])}→${_sym(top[j])}→${_sym(top[k])}→${_sym(base)}`,
              baseMint: base,
            });
          }
        }
      }
    }
  }

  return routes;
}

// ── Simulate a single route via Jupiter quotes ────────────────
export async function simulateRoute(route, inputAmount) {
  const tokens = route.tokens;
  const base   = tokens[0];

  // Determine input raw amount based on base token decimals
  const baseInfo  = Object.values(BASE_TOKENS).find(b => b.mint === base);
  const decimals  = baseInfo?.decimals ?? 6;
  let   currentAmt = Math.floor(inputAmount * Math.pow(10, decimals));

  const legs = [];

  for (let i = 0; i < tokens.length - 1; i++) {
    const fromMint = tokens[i];
    const toMint   = tokens[i + 1];

    const quote = await getJupiterQuote({
      inputMint:   fromMint,
      outputMint:  toMint,
      amount:      currentAmt,
      slippageBps: Math.floor(CONFIG.maxSlippagePct * 100),
    });

    if (!quote) return null;
    if (quote.priceImpactPct > CONFIG.maxSlippagePct) return null; // skip high impact

    legs.push({
      from:         fromMint,
      to:           toMint,
      inputAmount:  currentAmt,
      outputAmount: quote.outputAmount,
      minOutput:    quote.minOutput,
      priceImpact:  quote.priceImpactPct,
      routePlan:    quote.routePlan,
      raw:          quote.raw,
    });

    currentAmt = quote.outputAmount;
  }

  const finalRaw    = currentAmt;
  const finalAmt    = finalRaw / Math.pow(10, decimals);
  const profitAmt   = finalAmt - inputAmount;
  const roiMultiplier = finalAmt / inputAmount;

  return {
    routeName:     route.name,
    tokens:        route.tokens,
    hops:          route.hops,
    baseMint:      base,
    inputAmount,
    outputAmount:  finalAmt,
    profitAmount:  profitAmt,
    profitUsdc:    profitAmt, // alias for compat
    roiMultiplier,
    profitable:    profitAmt > 0,
    legs,
  };
}

// ── Scan ALL discovered routes, return profitable ones ────────
export async function scanAllRoutes(inputAmount, { maxHops, minTvl } = {}) {
  const { baseMints, midTokens } = await discoverLiquidTokens({ minTvl });

  if (midTokens.length === 0) {
    logger.warn("Route builder: no mid-tokens discovered");
    return [];
  }

  // With API key: more mid-tokens and faster. Without: conservative.
  const maxMid   = CONFIG.jupiterApiKey
    ? (CONFIG.maxMidTokens ?? 30)
    : (CONFIG.maxMidTokens ?? 10);
  const DELAY_MS = CONFIG.jupiterApiKey ? 50 : 600;

  const topMidTokens = midTokens.slice(0, maxMid);
  const hops         = Math.min(maxHops ?? CONFIG.maxHops ?? 2, CONFIG.jupiterApiKey ? 3 : 2);
  const routes       = buildRoutes(baseMints, topMidTokens, hops);
  const profitable   = [];

  logger.scan(`Scanning ${routes.length} routes (${baseMints.length} base × ${topMidTokens.length} mid, max ${hops}hop) | delay=${DELAY_MS}ms...`);

  for (const route of routes) {
    const sim = await simulateRouteWithRetry(route, inputAmount);
    if (
      sim && sim.profitable &&
      sim.profitAmount  >= CONFIG.minProfitUsd &&
      sim.roiMultiplier >= CONFIG.minRoiMultiplier
    ) {
      profitable.push(sim);
      logger.found(`🔥 ${sim.routeName} | profit=$${sim.profitAmount.toFixed(2)} | ROI=${sim.roiMultiplier.toFixed(0)}x`);
    }
    if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
  }

  profitable.sort((a, b) => b.profitAmount - a.profitAmount);
  return profitable;
}

// ── Simulate with retry on 429 ────────────────────────────────
async function simulateRouteWithRetry(route, inputAmount, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await simulateRoute(route, inputAmount);
    } catch (e) {
      if (e?.response?.status === 429 && attempt < retries) {
        const wait = 2000 * (attempt + 1);
        logger.warn(`Rate limited — waiting ${wait}ms before retry ${attempt + 1}/${retries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ── Symbol shorthand helper ───────────────────────────────────
function _sym(mint) {
  // Try to find symbol from BASE_TOKENS
  for (const [sym, info] of Object.entries(BASE_TOKENS)) {
    if (info.mint === mint) return sym;
  }
  // Shorten mint address
  return mint.slice(0, 4) + ".." + mint.slice(-4);
}
