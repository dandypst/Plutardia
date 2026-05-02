// scanner.js — Core arbitrage scanner
// Finds DAMM v2 vs DLMM price discrepancies and evaluates routes via Jupiter

import { simulateArbRoute, MINT_ADDRESSES } from "./tools/jupiter.js";
import { screenPools } from "./tools/dlmm.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

// State
let _scanCount    = 0;
let _foundCount   = 0;
const _discovered = new Map(); // poolAddress → { mintX, mintY, lastSeen }

// ── Discover new DAMM v2 / DLMM pool pairs from Meteora API ──
async function discoverPoolPairs() {
  const pools = await screenPools({
    minTvl:  CONFIG.minTvl,
    limit:   50,
    sortBy:  "volume",
  });

  for (const pool of pools) {
    // Only track pools where one side is USDC — compare as strings
    const usdcMint = MINT_ADDRESSES.USDC.toString();
    const hasUsdc  = pool.mintX?.toString() === usdcMint || pool.mintY?.toString() === usdcMint;
    if (!hasUsdc) continue;

    if (!_discovered.has(pool.address)) {
      const midMint = pool.mintX?.toString() === usdcMint ? pool.mintY : pool.mintX;
      _discovered.set(pool.address, { ...pool, midMint });
      logger.dim(`Pool discovered: ${pool.name} (${pool.address.slice(0, 8)}...) TVL=$${pool.tvl.toFixed(0)}`);
    }
  }

  return pools;
}

// ── Build dynamic routes from discovered pools ─────────────────
function buildDynamicRoutes(pools) {
  const routes = [];

  // Static configured routes first
  for (const r of CONFIG.arbRoutes) {
    routes.push(r);
  }

  // Dynamic 2-hop routes from discovered pools
  for (const [addr, pool] of _discovered) {
    const midToken = pool.name?.split("-").find(t => t !== "USDC") || "UNKNOWN";
    if (!midToken || midToken === "UNKNOWN") continue;
    if (!MINT_ADDRESSES[midToken]) {
      // Add discovered token mint to our known mints
      MINT_ADDRESSES[midToken] = pool.midMint;
    }

    routes.push({
      name:   `USDC→${midToken}→USDC (auto)`,
      hops:   2,
      tokens: ["USDC", midToken, "USDC"],
      pools:  ["DAMM_V2", "DLMM"],
      dynamic: true,
      poolAddr: addr,
    });
  }

  return routes;
}

// ── Core scan function ─────────────────────────────────────────
export async function scan(inputAmountUsdc = CONFIG.inputAmountUsdc) {
  _scanCount++;
  logger.scan(`Scan #${_scanCount} — input: $${inputAmountUsdc} USDC`);

  // Discover new pools periodically (every 10 scans)
  if (_scanCount % 10 === 1) {
    await discoverPoolPairs();
  }

  const routes     = buildDynamicRoutes([]);
  const results    = [];
  const profitable = [];

  await Promise.allSettled(
    routes.map(async (route) => {
      try {
        const sim = await simulateArbRoute(route, inputAmountUsdc);
        if (!sim) return;

        results.push(sim);

        if (
          sim.profitable &&
          sim.profitUsdc  >= CONFIG.minProfitUsd &&
          sim.roiMultiplier >= CONFIG.minRoiMultiplier
        ) {
          _foundCount++;
          profitable.push(sim);

          logger.found(
            `🔥 ARB: ${sim.routeName} | In: $${sim.inputUsdc.toFixed(4)} | Out: $${sim.outputUsdc.toFixed(2)} | Profit: $${sim.profitUsdc.toFixed(2)} | ROI: ${sim.roiMultiplier.toFixed(0)}x`
          );
        }
      } catch (e) {
        logger.error(`Route error [${route.name}]: ${e.message}`);
      }
    })
  );

  logger.dim(`Scan #${_scanCount} done — ${results.length} routes checked, ${profitable.length} profitable`);

  return {
    scanId:     _scanCount,
    timestamp:  Date.now(),
    checked:    results.length,
    profitable,
    allResults: results,
  };
}

export function getStats() {
  return { scans: _scanCount, found: _foundCount, pools: _discovered.size };
}
