// tools/jupiter.js — Jupiter aggregator integration
// Supports API key for paid tier (higher rate limits)

import axios from "axios";
import logger from "../logger.js";
import { resolveMint, BASE_TOKENS, MINT_ADDRESSES } from "./token_registry.js";
import CONFIG from "../config.js";

export { MINT_ADDRESSES } from "./token_registry.js";

// ── Endpoints & headers ───────────────────────────────────────
const JUPITER_ENDPOINTS = [
  "https://api.jup.ag/swap/v1",
  "https://lite-api.jup.ag/swap/v1",
];

function getHeaders() {
  return CONFIG.jupiterApiKey
    ? { "x-api-key": CONFIG.jupiterApiKey }
    : {};
}

// ── Quote cache (TTL 30s) ─────────────────────────────────────
const _quoteCache  = new Map();
const CACHE_TTL_MS = 30_000;
function cacheKey(a, b, n) { return `${a}:${b}:${n}`; }

// ── HTTP helpers with retry ───────────────────────────────────
async function jupiterGet(path, params, retries = 3) {
  const headers = getHeaders();
  for (const base of JUPITER_ENDPOINTS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios.get(`${base}${path}`, { params, headers, timeout: 15000 });
      } catch (e) {
        if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") break; // try next endpoint
        if (e?.response?.status === 429 && attempt < retries) {
          // Paid tier: short wait. Free tier: longer wait.
          const wait = CONFIG.jupiterApiKey ? 100 : 2000 * (attempt + 1);
          logger.warn(`Jupiter 429 — waiting ${wait}ms (attempt ${attempt + 1}/${retries})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (e.code === "ECONNABORTED" && attempt < retries) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        throw e;
      }
    }
  }
  throw new Error("All Jupiter endpoints failed");
}

async function jupiterPost(path, body, retries = 2) {
  const headers = getHeaders();
  for (const base of JUPITER_ENDPOINTS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await axios.post(`${base}${path}`, body, { headers, timeout: 15000 });
      } catch (e) {
        if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") break;
        if (e?.response?.status === 429 && attempt < retries) {
          await new Promise(r => setTimeout(r, CONFIG.jupiterApiKey ? 100 : 1000));
          continue;
        }
        throw e;
      }
    }
  }
  throw new Error("All Jupiter endpoints failed");
}

// ── Get a swap quote ──────────────────────────────────────────
export async function getJupiterQuote({
  inputMint, outputMint, amount, slippageBps = 50, onlyDirectRoutes = false,
} = {}) {
  try {
    const inMint  = (await resolveMint(inputMint))  || inputMint;
    const outMint = (await resolveMint(outputMint)) || outputMint;

    // Cache check
    const key    = cacheKey(inMint, outMint, amount);
    const cached = _quoteCache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

    const resp = await jupiterGet("/quote", {
      inputMint: inMint, outputMint: outMint,
      amount: amount.toString(), slippageBps: slippageBps.toString(),
      onlyDirectRoutes: onlyDirectRoutes.toString(),
      restrictIntermediateTokens: "true",
    });

    const q      = resp.data;
    const result = {
      inputAmount:    parseInt(q.inAmount),
      outputAmount:   parseInt(q.outAmount),
      minOutput:      parseInt(q.otherAmountThreshold),
      priceImpactPct: parseFloat(q.priceImpactPct || 0),
      routePlan:      q.routePlan || [],
      raw:            q,
    };

    _quoteCache.set(key, { data: result, ts: Date.now() });
    return result;
  } catch (e) {
    logger.error(`getJupiterQuote: ${e.message}`);
    return null;
  }
}

// ── Get swap transaction ──────────────────────────────────────
export async function getJupiterSwapTx(quote, userPublicKey, { wrapUnwrapSOL = true } = {}) {
  try {
    const resp = await jupiterPost("/swap", {
      quoteResponse:             quote.raw,
      userPublicKey,
      wrapAndUnwrapSol:          wrapUnwrapSOL,
      dynamicComputeUnitLimit:   true,
      prioritizationFeeLamports: "auto",
    });
    return resp.data.swapTransaction;
  } catch (e) {
    logger.error(`getJupiterSwapTx: ${e.message}`);
    return null;
  }
}

// ── Get token price ───────────────────────────────────────────
export async function getTokenPrice(mintAddr) {
  try {
    const quote = await getJupiterQuote({
      inputMint:  mintAddr,
      outputMint: BASE_TOKENS.USDC.mint,
      amount:     1_000_000,
    });
    return quote ? quote.outputAmount / 1e6 : null;
  } catch {
    return null;
  }
}

// ── Simulate multi-hop arb route ─────────────────────────────
export async function simulateArbRoute(route, inputAmount) {
  const firstToken = route.tokens[0];
  const baseMint   = (await resolveMint(firstToken)) || firstToken;
  const baseInfo   = Object.values(BASE_TOKENS).find(b => b.mint === baseMint);
  const decimals   = baseInfo?.decimals ?? 6;
  const inputRaw   = Math.floor(inputAmount * Math.pow(10, decimals));

  let currentAmount = inputRaw;
  const legs        = [];

  for (let i = 0; i < route.tokens.length - 1; i++) {
    const fromMint = (await resolveMint(route.tokens[i]))     || route.tokens[i];
    const toMint   = (await resolveMint(route.tokens[i + 1])) || route.tokens[i + 1];

    if (!fromMint || !toMint) return null;

    const quote = await getJupiterQuote({
      inputMint: fromMint, outputMint: toMint,
      amount: currentAmount, slippageBps: 100,
    });

    if (!quote) return null;

    legs.push({
      from: route.tokens[i], to: route.tokens[i + 1],
      fromMint, toMint,
      inputAmount: currentAmount, outputAmount: quote.outputAmount,
      minOutput: quote.minOutput, priceImpact: quote.priceImpactPct,
      raw: quote.raw,
    });

    currentAmount = quote.outputAmount;
  }

  const finalAmt      = currentAmount / Math.pow(10, decimals);
  const profitAmt     = finalAmt - inputAmount;
  const roiMultiplier = finalAmt / inputAmount;

  return {
    routeName: route.name, tokens: route.tokens, baseMint,
    inputAmount, inputUsdc: inputAmount,
    outputAmount: finalAmt, outputUsdc: finalAmt,
    profitAmount: profitAmt, profitUsdc: profitAmt,
    roiMultiplier, profitable: profitAmt > 0, legs,
  };
}
