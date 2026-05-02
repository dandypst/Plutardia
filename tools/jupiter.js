// tools/jupiter.js — Jupiter aggregator integration
// Used for: price discovery, swap quotes, and actual swap execution

import axios from "axios";
import logger from "../logger.js";

const JUPITER_API = "https://quote-api.jup.ag/v6";

// Well-known mint addresses
export const MINT_ADDRESSES = {
  USDC:  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL:   "So11111111111111111111111111111111111111112",
  USDT:  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  mSOL:  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  JUP:   "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  WIF:   "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  BONK:  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  PYTH:  "HZ1JovNiVvGrGs68OsfMXe1BG88Z28o5E41y7hFJa5dy",
};

// ── Get a swap quote from Jupiter ────────────────────────────
export async function getJupiterQuote({
  inputMint,
  outputMint,
  amount,           // in raw lamports/smallest unit
  slippageBps = 50, // 0.5% default
  onlyDirectRoutes = false,
} = {}) {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount:           amount.toString(),
      slippageBps:      slippageBps.toString(),
      onlyDirectRoutes: onlyDirectRoutes.toString(),
      restrictIntermediateTokens: "true",
    });

    const resp = await axios.get(`${JUPITER_API}/quote?${params}`, { timeout: 5000 });
    const q    = resp.data;

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
    const body = {
      quoteResponse:   quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: wrapUnwrapSOL,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    };

    const resp = await axios.post(`${JUPITER_API}/swap`, body, { timeout: 10_000 });
    return resp.data.swapTransaction; // base64 encoded versioned tx
  } catch (e) {
    logger.error(`getJupiterSwapTx: ${e.message}`);
    return null;
  }
}

// ── Get price (USD) for a token ──────────────────────────────
export async function getTokenPrice(mintAddr) {
  try {
    const resp = await axios.get(
      `https://price.jup.ag/v4/price?ids=${mintAddr}`,
      { timeout: 3000 }
    );
    const data = resp.data?.data?.[mintAddr];
    return data ? parseFloat(data.price) : null;
  } catch {
    return null;
  }
}

// ── Simulate a multi-hop arb route ───────────────────────────
// Returns full route quote chain: USDC → A → [B] → USDC
export async function simulateArbRoute(route, inputAmountUsdc) {
  const inputRaw = Math.floor(inputAmountUsdc * 1e6); // USDC 6 decimals

  let currentMint   = MINT_ADDRESSES.USDC;
  let currentAmount = inputRaw;
  const legs        = [];

  for (let i = 0; i < route.tokens.length - 1; i++) {
    const fromToken = route.tokens[i];
    const toToken   = route.tokens[i + 1];
    const fromMint  = MINT_ADDRESSES[fromToken] || fromToken;
    const toMint    = MINT_ADDRESSES[toToken]   || toToken;

    if (!fromMint || !toMint) {
      logger.warn(`Unknown token in route: ${fromToken} or ${toToken}`);
      return null;
    }

    const quote = await getJupiterQuote({
      inputMint:  fromMint,
      outputMint: toMint,
      amount:     currentAmount,
      slippageBps: 100,
    });

    if (!quote) return null;

    legs.push({
      from:        fromToken,
      to:          toToken,
      inputAmount: currentAmount,
      outputAmount: quote.outputAmount,
      priceImpact: quote.priceImpactPct,
    });

    currentMint   = toMint;
    currentAmount = quote.outputAmount;
  }

  // Final output is USDC
  const finalUsdcRaw  = currentAmount;
  const finalUsdcAmt  = finalUsdcRaw / 1e6;
  const profitUsd     = finalUsdcAmt - inputAmountUsdc;
  const roiMultiplier = finalUsdcAmt / inputAmountUsdc;

  return {
    routeName:      route.name,
    inputUsdc:      inputAmountUsdc,
    outputUsdc:     finalUsdcAmt,
    profitUsdc:     profitUsd,
    roiMultiplier,
    legs,
    profitable:     profitUsd > 0,
  };
}
