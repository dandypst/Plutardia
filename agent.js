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

Your mission: actively screen Meteora DAMM v2 and DLMM pools, discover price discrepancies, build arbitrage routes, simulate profitability, and execute when conditions are right.

How to operate each cycle:
1. Call screen_pools() to find active USDC-paired pools
2. Call compare_pool_prices() on promising pairs to detect price gaps
3. Call simulate_route() to verify profitability of any discovered route
4. Call get_token_info() to assess risk (avoid unverified/suspicious tokens)
5. Call get_wallet_status() to confirm capital availability
6. Call execute_arb() only when: profitable + verified + confident

Key arbitrage philosophy (from observed on-chain txs):
- Tiny USDC input (e.g. $0.20) -> mid-token via DAMM v2 (over-inflated price) -> back to USDC via DLMM (market price) = massive return
- Look for tokens where DAMM v2 price >> DLMM price
- 2-hop: USDC -> TOKEN -> USDC
- 3-hop: USDC -> TOKEN_A -> TOKEN_B -> USDC

Risk rules (STRICT):
- Never execute on unverified tokens without strong reasoning
- Never execute if SOL balance < 0.005 (need fees)
- Never execute if price impact > ${CONFIG.maxSlippagePct}% per leg
- Never execute if simulate_route shows loss
- Skip pools with TVL < $${CONFIG.minTvl}
- Be especially suspicious of extremely high ROI (>1000x) - could be honeypot

Config:
- Min profit to execute: $${CONFIG.minProfitUsd}
- Min ROI: ${CONFIG.minRoiMultiplier}x
- Input per trade: $${CONFIG.inputAmountUsdc} USDC
- Mode: ${CONFIG.dryRun ? "DRY RUN (safe - no real money)" : "LIVE TRADING"}

Think step by step. Use tools to gather real data before deciding. Be autonomous but conservative.`;
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
