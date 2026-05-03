// tools/token_registry.js — Dynamic token registry
// Resolves any token symbol or mint address on Solana
// Auto-discovers tokens from pool screening results

import axios from "axios";
import logger from "../logger.js";

// ── Well-known base tokens (start/end of arb routes) ─────────
export const BASE_TOKENS = {
  USDC: {
    mint:     "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    symbol:   "USDC",
  },
  SOL: {
    mint:     "So11111111111111111111111111111111111111112",
    decimals: 9,
    symbol:   "SOL",
  },
  USDT: {
    mint:     "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    symbol:   "USDT",
  },
};

// ── Runtime token cache (grows as pools are discovered) ───────
const _tokenCache = new Map(); // mint → { mint, symbol, decimals, name }

// Pre-populate with base tokens
for (const [symbol, info] of Object.entries(BASE_TOKENS)) {
  _tokenCache.set(info.mint, { ...info });
  _tokenCache.set(symbol, info.mint); // symbol → mint shortcut
}

// ── Fetch token metadata from Jupiter token list ──────────────
export async function fetchTokenMeta(mintOrSymbol) {
  // Already cached?
  if (_tokenCache.has(mintOrSymbol)) {
    const cached = _tokenCache.get(mintOrSymbol);
    // If it's a mint redirect (symbol → mint), resolve further
    if (typeof cached === "string") return _tokenCache.get(cached) || null;
    return cached;
  }

  try {
    // Try Jupiter strict token list first (fastest)
    const resp = await axios.get(
      `https://tokens.jup.ag/token/${mintOrSymbol}`,
      { timeout: 4000 }
    );
    const d = resp.data;
    const meta = {
      mint:     d.address,
      symbol:   d.symbol,
      name:     d.name,
      decimals: d.decimals,
      tags:     d.tags || [],
      verified: d.tags?.includes("verified") || false,
    };

    _tokenCache.set(meta.mint, meta);
    _tokenCache.set(meta.symbol, meta.mint);
    return meta;
  } catch {
    // Fallback: try Helius DAS API or return unknown
    logger.dim(`Token meta not found: ${mintOrSymbol}`);
    return null;
  }
}

// ── Resolve any identifier to a mint address ──────────────────
// Accepts: "USDC", "So111...", mint address, symbol
export async function resolveMint(identifier) {
  if (!identifier) return null;

  // Direct base token lookup
  if (BASE_TOKENS[identifier]) return BASE_TOKENS[identifier].mint;

  // Already a mint address (base58, ~44 chars)
  if (identifier.length >= 32) {
    // Cache it if not already
    if (!_tokenCache.has(identifier)) {
      await fetchTokenMeta(identifier); // populate cache
    }
    return identifier;
  }

  // Symbol lookup in cache
  const cached = _tokenCache.get(identifier);
  if (typeof cached === "string") return cached; // symbol → mint
  if (cached?.mint) return cached.mint;

  // Fetch from Jupiter
  const meta = await fetchTokenMeta(identifier);
  return meta?.mint || null;
}

// ── Get decimals for a mint ───────────────────────────────────
export async function getDecimals(mint) {
  // Base tokens
  for (const info of Object.values(BASE_TOKENS)) {
    if (info.mint === mint) return info.decimals;
  }

  const cached = _tokenCache.get(mint);
  if (cached?.decimals !== undefined) return cached.decimals;

  const meta = await fetchTokenMeta(mint);
  return meta?.decimals ?? 6; // default 6 if unknown
}

// ── Convert human amount → raw (lamports/smallest unit) ───────
export async function toRaw(amount, mint) {
  const decimals = await getDecimals(mint);
  return Math.floor(amount * Math.pow(10, decimals));
}

// ── Convert raw → human amount ────────────────────────────────
export async function fromRaw(rawAmount, mint) {
  const decimals = await getDecimals(mint);
  return rawAmount / Math.pow(10, decimals);
}

// ── Register tokens from pool screening ───────────────────────
// Called by scanner/agent when new pools are discovered
export async function registerPoolTokens(pools) {
  const unknown = [];

  for (const pool of pools) {
    for (const mint of [pool.mintX, pool.mintY]) {
      if (mint && !_tokenCache.has(mint)) {
        unknown.push(mint);
      }
    }
  }

  if (unknown.length === 0) return;

  // Batch fetch from Jupiter token list
  try {
    const resp = await axios.get("https://tokens.jup.ag/tokens?tags=verified", { timeout: 8000 });
    const allTokens = resp.data || [];
    const byMint    = new Map(allTokens.map(t => [t.address, t]));

    for (const mint of unknown) {
      const t = byMint.get(mint);
      if (t) {
        const meta = {
          mint:     t.address,
          symbol:   t.symbol,
          name:     t.name,
          decimals: t.decimals,
          tags:     t.tags || [],
          verified: true,
        };
        _tokenCache.set(mint, meta);
        _tokenCache.set(t.symbol, mint);
      } else {
        // Not in verified list — try individual fetch
        await fetchTokenMeta(mint).catch(() => null);
      }
    }

    logger.dim(`Token registry: ${_tokenCache.size} tokens cached (${unknown.length} new)`);
  } catch (e) {
    logger.warn(`registerPoolTokens batch fetch failed: ${e.message}`);
  }
}

// ── Get all known mints (for route building) ──────────────────
export function getAllCachedMints() {
  const mints = [];
  for (const [key, val] of _tokenCache.entries()) {
    if (key.length >= 32 && typeof val === "object") {
      mints.push(val);
    }
  }
  return mints;
}

// ── MINT_ADDRESSES compat shim (used by legacy code) ──────────
// Returns a Proxy that resolves symbols dynamically
export const MINT_ADDRESSES = new Proxy({}, {
  get(_, prop) {
    if (BASE_TOKENS[prop]) return BASE_TOKENS[prop].mint;
    const cached = _tokenCache.get(prop);
    if (typeof cached === "string") return cached;
    if (cached?.mint) return cached.mint;
    return undefined;
  },
  set(_, prop, value) {
    _tokenCache.set(prop, value);
    return true;
  },
});
