// agent.js — Autonomous ReAct agent with tool calling (OpenRouter)
// Full loop: Observe → Reason → Tool call → Observe result → Reason → Act
// Agent can: screen markets, discover routes, simulate, compare prices, execute

import axios from "axios";
import CONFIG from "./config.js";
import logger from "./logger.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { dispatchTool } from "./tools/tool_executor.js";
import { state } from "./state.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1/chat/completions";

// ── Session memory (Meridian pattern) ────────────────────────
const _sessionHistory = [];
const MAX_HISTORY     = 20;

// ── Agent stats ───────────────────────────────────────────────
let _cycleCount    = 0;
let _toolCallCount = 0;
let _execDecisions = 0;
let _agentTimer    = null;
let _isRunning     = false;

// ── System prompt ─────────────────────────────────────────────
function buildSystemPrompt() {
  return `You are Plutardia, an autonomous Solana arbitrage agent.

Your mission: find and execute the most profitable arbitrage routes across the entire Solana network — not just specific known routes, but ANY route involving ANY token pair.

How to operate each cycle:
1. Call scan_all_routes() — this discovers ALL liquid pools on Meteora, builds every possible route combination, and returns the most profitable ones ranked by profit
2. For top results: call get_token_info() to assess risk on unfamiliar tokens
3. Call get_wallet_status() to confirm capital availability
4. Call execute_arb() on the best verified opportunity

Use simulate_route() for custom routes you want to test manually.
Use compare_pool_prices() when you suspect a specific price gap between pools.
Use screen_pools() when you want raw pool data without route simulation.

Base tokens (start/end of routes): ${(CONFIG.baseTokens || ["USDC", "SOL"]).join(", ")}
Max hops per route: ${CONFIG.maxHops ?? 3}

Key arbitrage philosophy:
- Tiny input → mid-token via overpriced pool → back to base via market-rate pool = profit
- Price discrepancy between DAMM v2 and DLMM is the primary signal
- The network has thousands of pools — scan_all_routes() finds what humans miss

Risk rules (STRICT):
- Never execute on unverified tokens without strong reasoning
- Never execute if SOL balance < 0.005
- Never execute if simulate_route shows loss
- Skip pools with TVL < $${CONFIG.minTvl}
- Suspicious of extremely high ROI (>10000x) — likely honeypot or bad data

Config:
- Min profit: $${CONFIG.minProfitUsd}
- Min ROI: ${CONFIG.minRoiMultiplier}x
- USDC input: $${CONFIG.inputAmountUsdc}
- SOL input: ${CONFIG.inputAmountSol ?? 0.001} SOL
- Mode: ${CONFIG.dryRun ? "DRY RUN (safe)" : "LIVE TRADING 🔴"}

Be autonomous. Use scan_all_routes() first — it does the heavy lifting.`;
}

// ── Call OpenRouter with tool support ─────────────────────────
async function callOpenRouter(messages) {
  if (!CONFIG.openRouterApiKey) throw new Error("OPENROUTER_API_KEY not set");

  const resp = await axios.post(
    OPENROUTER_API,
    {
      model:       CONFIG.agentModel,
      max_tokens:  CONFIG.agentMaxTokens,
      tools:       TOOL_DEFINITIONS,
      tool_choice: "auto",
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...messages,
      ],
    },
    {
      headers: {
        "Authorization": `Bearer ${CONFIG.openRouterApiKey}`,
        "Content-Type":  "application/json",
        "HTTP-Referer":  "https://github.com/plutardia",
        "X-Title":       "Plutardia Arb Bot",
      },
      timeout: 30_000,
    }
  );

  return resp.data.choices?.[0]?.message;
}

// ── ReAct loop: keeps running until agent stops calling tools ─
async function reactLoop(initialUserMessage, maxIterations = 10) {
  const historySnapshot = _sessionHistory.length; // snapshot before mutation
  const messages = [..._sessionHistory, { role: "user", content: initialUserMessage }];
  let iterations = 0;
  let finalText  = "";

  while (iterations < maxIterations) {
    iterations++;

    const assistantMsg = await callOpenRouter(messages);
    if (!assistantMsg) break;

    messages.push(assistantMsg);

    // No tool calls = agent finished reasoning
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      finalText = assistantMsg.content || "";
      break;
    }

    logger.dim(`[AGENT] Iteration ${iterations}: ${assistantMsg.tool_calls.length} tool call(s) — ${assistantMsg.tool_calls.map(t => t.function.name).join(", ")}`);

    // Execute all tool calls (parallel)
    const toolResults = await Promise.all(
      assistantMsg.tool_calls.map(async (toolCall) => {
        _toolCallCount++;
        const name = toolCall.function.name;
        let   args = {};
        try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch {}

        const result = await dispatchTool(name, args);

        return {
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        };
      })
    );

    messages.push(...toolResults);
  }

  // Update session history — only add new messages added during this loop
  const newMessages = messages.slice(historySnapshot);
  _sessionHistory.push(...newMessages);
  while (_sessionHistory.length > MAX_HISTORY) _sessionHistory.splice(0, 1);

  return finalText;
}

// ── Single agent reasoning cycle ─────────────────────────────
export async function runAgentCycle() {
  if (!CONFIG.agentEnabled || !CONFIG.openRouterApiKey) return null;

  _cycleCount++;
  const summary = state.summary();

  logger.exec(`[AGENT] ── Cycle #${_cycleCount} ── ${CONFIG.agentModel}`);

  const trigger = `Reasoning cycle #${_cycleCount}. Session stats: ${summary.totalExecs} executions, ${summary.wins} wins, $${summary.totalProfit} profit.

Start by screening pools for USDC-paired opportunities. Look for price discrepancies between DAMM v2 and DLMM pools. Simulate promising routes and execute if profitable and safe.`;

  try {
    const conclusion = await reactLoop(trigger);

    if (conclusion) {
      logger.info(`[AGENT] Cycle #${_cycleCount} done: ${conclusion.slice(0, 200)}`);
    }

    if (conclusion?.toLowerCase().includes("execut")) _execDecisions++;

    return conclusion;
  } catch (e) {
    logger.error(`[AGENT] Cycle #${_cycleCount} failed: ${e.message}`);
    return null;
  }
}

// ── Free-form chat with full tool access ─────────────────────
export async function chatWithAgent(userInput) {
  if (!CONFIG.openRouterApiKey) {
    return "Agent not available — set OPENROUTER_API_KEY in .env";
  }

  logger.dim(`[AGENT] Chat: "${userInput.slice(0, 80)}"`);

  try {
    const reply = await reactLoop(userInput, 8);
    return reply || "(Agent completed actions but returned no text)";
  } catch (e) {
    return `Agent error: ${e.message}`;
  }
}

// ── Start / stop ──────────────────────────────────────────────
export function startAgent() {
  if (!CONFIG.agentEnabled) {
    logger.warn("[AGENT] Disabled (agentEnabled=false in config)");
    return;
  }
  if (!CONFIG.openRouterApiKey) {
    logger.warn("[AGENT] Disabled — OPENROUTER_API_KEY not set in .env");
    return;
  }

  _isRunning = true;
  const intervalSec = CONFIG.agentIntervalMs / 1000;
  logger.success(`[AGENT] Started — model: ${CONFIG.agentModel} | interval: ${intervalSec}s`);

  // First cycle after 5s (let connection warm up)
  setTimeout(() => { if (_isRunning) runAgentCycle(); }, 5000);

  _agentTimer = setInterval(() => {
    if (_isRunning) runAgentCycle();
  }, CONFIG.agentIntervalMs);
}

export function stopAgent() {
  _isRunning = false;
  clearInterval(_agentTimer);
  logger.warn("[AGENT] Stopped");
}

export function getAgentStats() {
  return {
    cycles:    _cycleCount,
    toolCalls: _toolCallCount,
    executed:  _execDecisions,
    model:     CONFIG.agentModel,
    intervalS: CONFIG.agentIntervalMs / 1000,
    enabled:   CONFIG.agentEnabled && !!CONFIG.openRouterApiKey,
  };
}
