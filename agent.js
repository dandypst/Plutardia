// agent.js — AI Agent reasoning loop (OpenRouter)
// ReAct pattern: Observe market data → Reason → Decide → Act
// Runs on configurable interval independently from the scanner

import axios from "axios";
import CONFIG from "./config.js";
import logger from "./logger.js";
import { screenPools } from "./tools/dlmm.js";
import { getTokenPrice, MINT_ADDRESSES } from "./tools/jupiter.js";
import { getWalletStatus } from "./tools/wallet.js";
import { state } from "./state.js";
import { executeArb } from "./executor.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// ── Session memory (last N exchanges, Meridian pattern) ───────
const _sessionHistory = [];
const MAX_HISTORY     = 10;

// ── Agent stats ───────────────────────────────────────────────
let _cycleCount   = 0;
let _execDecisions = 0;
let _skipDecisions = 0;
let _agentTimer   = null;

// ── Call OpenRouter API ───────────────────────────────────────
async function callOpenRouter(messages, systemPrompt) {
  if (!CONFIG.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY not set — agent disabled");
  }

  const resp = await axios.post(
    OPENROUTER_API,
    {
      model:      CONFIG.agentModel,
      max_tokens: CONFIG.agentMaxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    },
    {
      headers: {
        "Authorization":  `Bearer ${CONFIG.openRouterApiKey}`,
        "Content-Type":   "application/json",
        "HTTP-Referer":   "https://github.com/plutardia",
        "X-Title":        "Plutardia Arb Bot",
      },
      timeout: 20_000,
    }
  );

  return resp.data.choices?.[0]?.message?.content || "";
}

// ── Build system prompt ───────────────────────────────────────
function buildSystemPrompt(walletStatus) {
  return `You are Plutardia, an autonomous Solana arbitrage agent.
Your job is to analyze market data and decide whether to execute arbitrage opportunities.

Current wallet:
- SOL: ${walletStatus.sol.toFixed(4)}
- USDC: $${walletStatus.usdc.toFixed(2)}
- Mode: ${CONFIG.dryRun ? "DRY RUN (simulation)" : "LIVE TRADING"}

Bot config:
- Min profit threshold: $${CONFIG.minProfitUsd}
- Min ROI multiplier: ${CONFIG.minRoiMultiplier}x
- Max slippage: ${CONFIG.maxSlippagePct}%
- Input per trade: $${CONFIG.inputAmountUsdc} USDC

You will receive:
1. Live pool screening data (TVL, volume, fee ratios)
2. Current arbitrage opportunities found by the scanner
3. Recent execution history

Respond ONLY with a valid JSON object in this exact format:
{
  "decision": "EXECUTE" | "SKIP" | "WAIT",
  "confidence": <number 0-100>,
  "reasoning": "<brief explanation>",
  "targets": [<list of routeNames to execute, empty if SKIP/WAIT>],
  "warnings": ["<any risk flags>"]
}

Decision guide:
- EXECUTE: High confidence opportunity, good pool conditions, execute now
- SKIP: Opportunity exists but conditions are risky (low TVL, high impact, suspicious volume)
- WAIT: No clear opportunity, continue scanning

Be conservative. Prioritize capital preservation over profit.`;
}

// ── Build user message with live market context ───────────────
async function buildMarketContext(opportunities) {
  // Fetch pool data
  const pools = await screenPools({ minTvl: CONFIG.minTvl, limit: 10 }).catch(() => []);

  // Fetch recent exec history
  const history = state.getProfitableHistory(0).slice(0, 5);
  const summary = state.summary();

  // Format opportunities
  const oppSummary = opportunities.length === 0
    ? "No profitable opportunities found this cycle."
    : opportunities.map(o =>
        `- ${o.routeName}: input=$${o.inputUsdc.toFixed(4)}, profit=$${o.profitUsdc.toFixed(2)}, ROI=${o.roiMultiplier.toFixed(0)}x, priceImpact=${o.legs?.map(l => l.priceImpact?.toFixed(2) + "%").join(" → ") || "unknown"}`
      ).join("\n");

  // Format top pools
  const poolSummary = pools.slice(0, 5).map(p =>
    `- ${p.name}: TVL=$${p.tvl.toFixed(0)}, vol24h=$${p.volume24h?.toFixed(0) || "?"}, fee24h=$${p.fee24h?.toFixed(0) || "?"}`
  ).join("\n");

  // Format history
  const histSummary = history.length === 0
    ? "No execution history yet."
    : history.map(h =>
        `- ${h.at}: ${h.success ? "SUCCESS" : "FAILED"} profit=$${h.profit?.toFixed(2) || 0}`
      ).join("\n");

  return `=== CYCLE #${_cycleCount} MARKET SNAPSHOT ===

ARBITRAGE OPPORTUNITIES:
${oppSummary}

TOP POOLS (by volume):
${poolSummary}

SESSION STATS:
- Total execs: ${summary.totalExecs} | Win rate: ${summary.winRate} | Total profit: $${summary.totalProfit}

RECENT HISTORY:
${histSummary}

Based on this data, what is your decision?`;
}

// ── Parse agent response safely ───────────────────────────────
function parseAgentResponse(raw) {
  try {
    // Strip markdown fences if present
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    logger.warn(`Agent response not valid JSON: ${raw.slice(0, 100)}`);
    return null;
  }
}

// ── Single agent reasoning cycle ─────────────────────────────
export async function runAgentCycle(opportunities = []) {
  if (!CONFIG.agentEnabled) return null;
  if (!CONFIG.openRouterApiKey) {
    logger.warn("Agent skipped — OPENROUTER_API_KEY not set");
    return null;
  }

  _cycleCount++;
  logger.exec(`[AGENT] Cycle #${_cycleCount} — reasoning with ${CONFIG.agentModel}...`);

  try {
    const walletStatus  = await getWalletStatus();
    const systemPrompt  = buildSystemPrompt(walletStatus);
    const userMessage   = await buildMarketContext(opportunities);

    // Add to session history (Meridian pattern)
    _sessionHistory.push({ role: "user", content: userMessage });
    if (_sessionHistory.length > MAX_HISTORY * 2) {
      _sessionHistory.splice(0, 2); // remove oldest exchange
    }

    const raw      = await callOpenRouter(_sessionHistory, systemPrompt);
    const decision = parseAgentResponse(raw);

    // Add assistant response to history
    _sessionHistory.push({ role: "assistant", content: raw });

    if (!decision) return null;

    logger.exec(`[AGENT] Decision: ${decision.decision} (confidence: ${decision.confidence}%)`);
    logger.exec(`[AGENT] Reasoning: ${decision.reasoning}`);

    if (decision.warnings?.length) {
      decision.warnings.forEach(w => logger.warn(`[AGENT] ⚠ ${w}`));
    }

    // ── Act on decision ───────────────────────────────────────
    if (
      decision.decision === "EXECUTE" &&
      decision.confidence >= CONFIG.agentConfidenceMin &&
      decision.targets?.length > 0
    ) {
      _execDecisions++;

      for (const targetRoute of decision.targets) {
        const opp = opportunities.find(o => o.routeName === targetRoute);
        if (!opp) {
          logger.warn(`[AGENT] Target route not found: ${targetRoute}`);
          continue;
        }

        logger.success(`[AGENT] Executing: ${targetRoute}`);
        const result = await executeArb(opp);
        if (result) {
          state.recordExec({ ...result, agentDecision: decision });
        }
      }
    } else if (decision.decision === "SKIP") {
      _skipDecisions++;
      logger.dim(`[AGENT] Skipping — ${decision.reasoning}`);
    } else {
      logger.dim(`[AGENT] Waiting — ${decision.reasoning}`);
    }

    return decision;

  } catch (e) {
    logger.error(`[AGENT] Cycle error: ${e.message}`);
    return null;
  }
}

// ── Chat with agent (free-form, Meridian pattern) ─────────────
export async function chatWithAgent(userInput) {
  if (!CONFIG.openRouterApiKey) {
    return "Agent not available — OPENROUTER_API_KEY not set.";
  }

  try {
    const walletStatus = await getWalletStatus();
    const systemPrompt = buildSystemPrompt(walletStatus);

    _sessionHistory.push({ role: "user", content: userInput });

    const raw = await callOpenRouter(_sessionHistory, systemPrompt);
    _sessionHistory.push({ role: "assistant", content: raw });

    return raw;
  } catch (e) {
    return `Agent error: ${e.message}`;
  }
}

// ── Start agent on interval ────────────────────────────────────
export function startAgent(getOpportunities) {
  if (!CONFIG.agentEnabled) {
    logger.warn("Agent disabled (agentEnabled=false in config)");
    return;
  }
  if (!CONFIG.openRouterApiKey) {
    logger.warn("Agent disabled — set OPENROUTER_API_KEY in .env");
    return;
  }

  const intervalSec = CONFIG.agentIntervalMs / 1000;
  logger.info(`[AGENT] Started — model: ${CONFIG.agentModel}, interval: ${intervalSec}s`);

  _agentTimer = setInterval(async () => {
    const opps = getOpportunities();
    await runAgentCycle(opps);
  }, CONFIG.agentIntervalMs);
}

// ── Stop agent ────────────────────────────────────────────────
export function stopAgent() {
  clearInterval(_agentTimer);
  logger.warn("[AGENT] Stopped");
}

export function getAgentStats() {
  return {
    cycles:    _cycleCount,
    executed:  _execDecisions,
    skipped:   _skipDecisions,
    model:     CONFIG.agentModel,
    intervalS: CONFIG.agentIntervalMs / 1000,
  };
}
