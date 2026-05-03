// scanner.js — Core arbitrage scanner
// Uses route_builder to dynamically discover ALL routes on Solana
// No hardcoded routes — discovers pools, builds routes, simulates live

import { scanAllRoutes } from "./tools/route_builder.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

let _scanCount  = 0;
let _foundCount = 0;

// ── Core scan: discover + simulate all routes ─────────────────
export async function scan(inputAmount) {
  _scanCount++;
  logger.scan(`Scan #${_scanCount} — base tokens: ${CONFIG.baseTokens.join("/")} | max hops: ${CONFIG.maxHops}`);

  try {
    const profitable = await scanAllRoutes(inputAmount, {
      maxHops: CONFIG.maxHops,
      minTvl:  CONFIG.minTvl,
    });

    _foundCount += profitable.length;

    logger.dim(`Scan #${_scanCount} done — ${profitable.length} profitable routes found`);

    return {
      scanId:     _scanCount,
      timestamp:  Date.now(),
      profitable,
    };
  } catch (e) {
    logger.error(`Scan #${_scanCount} failed: ${e.message}`);
    return { scanId: _scanCount, timestamp: Date.now(), profitable: [] };
  }
}

export function getStats() {
  return { scans: _scanCount, found: _foundCount };
}
