// index.js — Main entry point
// Architecture: adopted from Meridian (REPL + cron + Telegram)
// Arb logic: Meteora DAMM v2 / DLMM price discrepancy exploitation

import readline from "readline";
import cron from "node-cron";
import { scan, getStats as getScanStats } from "./scanner.js";
import { executeArb, getExecStats } from "./executor.js";
import { getWalletStatus } from "./tools/wallet.js";
import { state } from "./state.js";
import { startAgent, stopAgent, chatWithAgent, getAgentStats } from "./agent.js";
import {
  startPolling,
  stopPolling,
  notifyArbFound,
  notifyExecSuccess,
  notifyExecFailed,
  notifySummary,
  sendMessage,
} from "./telegram.js";
import CONFIG from "./config.js";
import logger from "./logger.js";

// ── Bot state ─────────────────────────────────────────────────
let isRunning        = false;
let autoExec         = false;
let scanTimer        = null;
let _liveOpportunities = []; // shared buffer: scanner → agent

// ── Banner ────────────────────────────────────────────────────
logger.banner("PLUTARDIA v1.0");
logger.info(`Mode:         ${CONFIG.dryRun ? "DRY RUN ⚠" : "LIVE 🔴"}`);
logger.info(`RPC:          ${CONFIG.rpcUrl.slice(0, 50)}...`);
logger.info(`Min profit:   $${CONFIG.minProfitUsd}`);
logger.info(`Min ROI:      ${CONFIG.minRoiMultiplier}x`);
logger.info(`Input USDC:   $${CONFIG.inputAmountUsdc}`);
logger.info(`Max slippage: ${CONFIG.maxSlippagePct}%`);
logger.info(`Flash loans:  ${CONFIG.useFlashLoan ? "enabled" : "disabled"}`);
logger.info(`Jito tip:     ${CONFIG.jitoTipLamports} lamports`);
logger.info(`AI Agent:     ${CONFIG.agentEnabled && CONFIG.openRouterApiKey ? `${CONFIG.agentModel} @ ${CONFIG.agentIntervalMs / 1000}s` : "disabled"}`);
logger.info("");

if (CONFIG.dryRun) {
  logger.warn("DRY RUN MODE — no real transactions will be sent");
  logger.warn("Set DRY_RUN=false in .env to go live");
  logger.info("");
}

// ── Core scan + execute loop ──────────────────────────────────
async function runScan() {
  if (!isRunning) return;

  const result = await scan(CONFIG.inputAmountUsdc);

  // Update live buffer for agent to read
  _liveOpportunities = result.profitable;

  for (const opp of result.profitable) {
    state.addOpportunity(opp);
    notifyArbFound(opp).catch(() => {});

    // autoExec without agent = rule-based execute
    if (autoExec && !CONFIG.agentEnabled) {
      const execResult = await executeArb(opp);
      if (execResult) {
        state.recordExec(execResult);
        if (execResult.success) notifyExecSuccess(execResult).catch(() => {});
        else notifyExecFailed(execResult.error).catch(() => {});
      }
    }
  }
  // Note: when agentEnabled=true, execution is handled by agent.js on its own interval
}

// ── Start / stop ──────────────────────────────────────────────
function startBot() {
  if (isRunning) { logger.warn("Bot already running"); return; }
  isRunning = true;
  logger.success("Bot started — scanning every " + CONFIG.scanIntervalMs / 1000 + "s");

  runScan();
  scanTimer = setInterval(runScan, CONFIG.scanIntervalMs);

  // Start AI agent on its own interval (fully autonomous)
  startAgent();
}

function stopBot() {
  isRunning = false;
  clearInterval(scanTimer);
  stopAgent();
  logger.warn("Bot stopped");
}

// ── Hourly summary (Meridian cron pattern) ────────────────────
cron.schedule("0 * * * *", () => {
  const scanStats = getScanStats();
  const execStats = getExecStats();
  const combined  = { ...scanStats, ...execStats };
  logger.info("Hourly summary: " + JSON.stringify(combined));
  notifySummary(combined).catch(() => {});
});

// ── Telegram command handler ──────────────────────────────────
async function handleTelegramCommand(text, chatId) {
  logger.dim(`Telegram cmd: ${text}`);
  const cmd = text.toLowerCase();

  if (cmd === "/start") {
    startBot();
    sendMessage("✅ Bot started", chatId);
  } else if (cmd === "/stop") {
    stopBot();
    sendMessage("⛔ Bot stopped", chatId);
  } else if (cmd === "/status") {
    try {
      const w = await getWalletStatus();
      const s = state.summary();
      sendMessage(`💼 <b>Status</b>\nSOL: ${w.sol.toFixed(4)}\nUSDC: $${w.usdc.toFixed(2)}\nProfit: $${s.totalProfit}\nWinRate: ${s.winRate}\nUptime: ${s.uptime}`, chatId);
    } catch (e) {
      sendMessage("Error: " + e.message, chatId);
    }
  } else if (cmd === "/autoexec on") {
    autoExec = true;
    sendMessage("🤖 Auto-execute ON", chatId);
  } else if (cmd === "/autoexec off") {
    autoExec = false;
    sendMessage("🔒 Auto-execute OFF", chatId);
  } else if (cmd === "/profit") {
    sendMessage(`💰 Total profit: $${state.getTotalProfit().toFixed(2)} USDC`, chatId);
  }
}

// ── REPL interface (Meridian pattern) ─────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function prompt() {
  const scanStats = getScanStats();
  const execStats = getExecStats();
  rl.question(
    `\n[scans:${scanStats.scans} | found:${scanStats.found} | profit:$${execStats.totalProfit.toFixed(0)} | ${isRunning ? "RUNNING" : "STOPPED"}] > `,
    async (input) => {
      const cmd = input.trim().toLowerCase();

      if (cmd === "start") {
        startBot();
      } else if (cmd === "stop") {
        stopBot();
      } else if (cmd === "auto on") {
        autoExec = true;
        logger.success("Auto-execute enabled — will execute all opportunities automatically");
      } else if (cmd === "auto off") {
        autoExec = false;
        logger.warn("Auto-execute disabled — manual execution only");
      } else if (cmd === "status" || cmd === "/status") {
        try {
          const w = await getWalletStatus();
          const s = state.summary();
          logger.banner("STATUS");
          console.log(`  Wallet:   ${w.address}`);
          console.log(`  SOL:      ${w.sol.toFixed(6)}`);
          console.log(`  USDC:     $${w.usdc.toFixed(2)}`);
          console.log(`  ───────────────────────`);
          console.log(`  Uptime:   ${s.uptime}`);
          console.log(`  Execs:    ${s.totalExecs} (${s.winRate} win)`);
          console.log(`  Profit:   $${s.totalProfit}`);
        } catch (e) {
          logger.error(e.message);
        }
      } else if (cmd === "scan") {
        logger.info("Manual scan triggered...");
        const r = await scan(CONFIG.inputAmountUsdc);
        logger.info(`Found ${r.profitable.length} opportunities`);
      } else if (cmd.startsWith("exec ")) {
        // exec <route name>
        const routeName = cmd.slice(5);
        const opps      = state.getOpportunities(10);
        const opp       = opps.find(o => o.routeName?.toLowerCase().includes(routeName));
        if (opp) {
          const result = await executeArb(opp);
          if (result) state.recordExec(result);
        } else {
          logger.warn("Opportunity not found. Run 'scan' first.");
        }
      } else if (cmd === "history") {
        const hist = state.getOpportunities(5);
        hist.forEach(o => {
          console.log(`  ${o.routeName} | $${o.profitUsdc?.toFixed(2)} profit`);
        });
      } else if (cmd === "config") {
        console.log("\n  " + JSON.stringify({
          dryRun: CONFIG.dryRun,
          minProfitUsd: CONFIG.minProfitUsd,
          minRoiMultiplier: CONFIG.minRoiMultiplier,
          inputAmountUsdc: CONFIG.inputAmountUsdc,
          maxSlippagePct: CONFIG.maxSlippagePct,
          useFlashLoan: CONFIG.useFlashLoan,
        }, null, 4).replace(/\n/g, "\n  "));
      } else if (cmd === "agent") {
        const s = getAgentStats();
        logger.info(`[AGENT] model=${s.model} | interval=${s.intervalS}s | cycles=${s.cycles} | exec=${s.executed} | skipped=${s.skipped}`);
      } else if (cmd.startsWith("chat ")) {
        const userInput = input.trim().slice(5);
        logger.info("[AGENT] Sending to agent...");
        const reply = await chatWithAgent(userInput);
        console.log(`\n  Agent: ${reply}\n`);
      } else if (cmd === "help" || cmd === "") {
        console.log(`
  Commands:
  ─────────────────────────────────────────
  start         Start bot (scan + agent loop)
  stop          Stop bot
  scan          Manual one-time scan
  auto on/off   Toggle auto-execution (rule-based, when agent disabled)
  exec <name>   Execute specific opportunity
  status        Wallet + stats
  agent         Show AI agent stats
  chat <msg>    Chat with AI agent directly
  history       Recent opportunities
  config        Show current config
  help          This menu
  exit          Quit
        `);
      } else if (cmd === "exit" || cmd === "quit") {
        logger.info("Shutting down...");
        stopBot();
        stopPolling();
        process.exit(0);
      } else if (cmd) {
        logger.warn(`Unknown command: "${cmd}" — type 'help' for list`);
      }

      prompt();
    }
  );
}

// ── Startup ───────────────────────────────────────────────────
if (CONFIG.telegramBotToken) {
  startPolling(handleTelegramCommand);
  logger.info("Telegram bot active — send any message to register your chat");
}

logger.info("Type 'help' for commands, 'start' to begin scanning\n");
prompt();

// ── Graceful shutdown ─────────────────────────────────────────
process.on("SIGINT", () => {
  logger.info("\nSIGINT — shutting down gracefully...");
  stopBot();
  stopPolling();
  const s = state.summary();
  logger.info(`Session summary: ${JSON.stringify(s)}`);
  process.exit(0);
});
