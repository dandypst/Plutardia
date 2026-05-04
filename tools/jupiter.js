// tools/jupiter.js — Jupiter aggregator integration
// Now uses token_registry for dynamic mint resolution (no hardcoded tokens)

import axios from "axios";
import logger from "../logger.js";
import { resolveMint, BASE_TOKENS, MINT_ADDRESSES } from "./token_registry.js";

export { MINT_ADDRESSES } from "./token_registry.js";

const JUPITER_ENDPOINTS = [
  "https://api.jup.ag/swap/v1",
  "https://lite-api.jup.ag/swap/v1",
];

let _activeEndpoint = JUPITER_ENDPOINTS[0];

async function jupiterGet(path, params, retries = 2) {
  for (const base of JUPITER_ENDPOINTS) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await axios.get(`${base}${path}`, { params, timeout: 8000 });
        _activeEndpoint = base;
        return resp;
      } catch (e) {
        if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") {
          logger.warn(`Jupiter endpoint unreachable: ${base} — trying next...`);
          break; // try next endpoint
        }
        if (e?.response?.status === 429 && attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue; // retry same endpoint
        }
        throw e;
      }
    }
  }
  throw new Error("All Jupiter endpoints unreachable or rate limited");
}

async function jupiterPost(path, body) {
  for (const base of JUPITER_ENDPOINTS) {
    try {
      const resp = await axios.post(`${base}${path}`, body, { timeout: 15000 });
      return resp;
    } catch (e) {
      if (e.code === "ENOTFOUND" || e.code === "ECONNREFUSED") {
        logger.warn(`Jupiter endpoint unreachable: ${base} — trying next...`);
        continue;
      }
      throw e;
    }
  }
  throw new Error("All Jupiter endpoints unreachable");
}

// ── Get a swap quote from Jupiter ────────────────────────────
export async function getJupiterQuote({
  inputMint,
  outputMint,
  amount,
  slippageBps = 50,
  onlyDirectRoutes = false,
} = {}) {
  try {
    const inMint  = (await resolveMint(inputMint))  || inputMint;
    const outMint = (await resolveMint(outputMint)) || outputMint;

    const resp = await jupiterGet("/quote", {
      inputMint:  inMint,
      outputMint: outMint,
      amount:     amount.toString(),
      slippageBps: slippageBps.toString(),
      onlyDirectRoutes: onlyDirectRoutes.toString(),
      restrictIntermediateTokens: "true",
    });

    const q = resp.data;
    return {
      inputAmount:    parseInt(q.inAmount),
      outputAmount:   parseInt(q.outAmount),
      minOutput:      parseInt(q.otherAmountThreshold),
      priceImpactPct: parseFloat(q.priceImpactPct || 0),
      routePlan:      q.routePlan || [],
      raw:            q,
    };
  } catch (e) {
    logger.error(`getJupiterQuote: ${e.message}`);
    return null;
  }
}

// ── Get swap transaction from Jupiter ────────────────────────
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

// ── Get USD price for any token ───────────────────────────────
export async function getTokenPrice(mintAddr) {
  try {
    const resp = await jupiterGet("/price", { ids: mintAddr });
    const data = resp.data?.data?.[mintAddr];
    return data ? parseFloat(data.price) : null;
  } catch {
    // Fallback: derive price from a USDC quote
    try {
      const quote = await getJupiterQuote({
        inputMint:  mintAddr,
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount:     1_000_000,
      });
      return quote ? quote.outputAmount / 1e6 : null;
    } catch {
      return null;
    }
  }
}

// ── Simulate a multi-hop arb route ────────────────────────────
// Accepts token symbols OR raw mint addresses
// Base token (first/last) can be USDC or SOL
export async function simulateArbRoute(route, inputAmount) {
  const firstToken = route.tokens[0];
  const baseMint   = (await resolveMint(firstToken)) || firstToken;

  const baseInfo = Object.values(BASE_TOKENS).find(b => b.mint === baseMint);
  const decimals = baseInfo?.decimals ?? 6;
  const inputRaw = Math.floor(inputAmount * Math.pow(10, decimals));

  let currentAmount = inputRaw;
  const legs        = [];

  for (let i = 0; i < route.tokens.length - 1; i++) {
    const fromToken = route.tokens[i];
    const toToken   = route.tokens[i + 1];
    const fromMint  = (await resolveMint(fromToken)) || fromToken;
    const toMint    = (await resolveMint(toToken))   || toToken;

    if (!fromMint || !toMint) {
      logger.warn(`simulateArbRoute: cannot resolve ${fromToken} or ${toToken}`);
      return null;
    }

    const quote = await getJupiterQuote({
      inputMint:   fromMint,
      outputMint:  toMint,
      amount:      currentAmount,
      slippageBps: 100,
    });

    if (!quote) return null;

    legs.push({
      from:        fromToken,
      to:          toToken,
      fromMint,
      toMint,
      inputAmount: currentAmount,
      outputAmount: quote.outputAmount,
      minOutput:   quote.minOutput,
      priceImpact: quote.priceImpactPct,
      raw:         quote.raw,
    });

    currentAmount = quote.outputAmount;
  }

  const finalAmt      = currentAmount / Math.pow(10, decimals);
  const profitAmt     = finalAmt - inputAmount;
  const roiMultiplier = finalAmt / inputAmount;

  return {
    routeName:     route.name,
    tokens:        route.tokens,
    baseMint,
    inputAmount,
    inputUsdc:     inputAmount,
    outputAmount:  finalAmt,
    outputUsdc:    finalAmt,
    profitAmount:  profitAmt,
    profitUsdc:    profitAmt,
    roiMultiplier,
    profitable:    profitAmt > 0,
    legs,
  };
}
