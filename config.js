// config.js — Runtime config (adopted from Meridian config pattern)
import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Load user-config.json if it exists ──────────────────────
function loadUserConfig() {
  const p = path.join(__dirname, "user-config.json");
  if (!existsSync(p)) {
    console.warn("[CONFIG] user-config.json not found — using defaults");
    return {};
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

const userCfg = loadUserConfig();

// ── Merge env + user-config ──────────────────────────────────
export const CONFIG = {
  // ─ Connection
  rpcUrl:           process.env.RPC_URL           || userCfg.rpcUrl   || "https://api.mainnet-beta.solana.com",
  heliusApiKey:     process.env.HELIUS_API_KEY    || userCfg.heliusApiKey || "",
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || userCfg.walletKey || "",

  // ─ Mode
  // Priority: DRY_RUN env var > user-config.dryRun > default true
  dryRun: process.env.DRY_RUN !== undefined
    ? process.env.DRY_RUN === "true"
    : (userCfg.dryRun !== undefined ? userCfg.dryRun : true),

  // ─ Arbitrage thresholds
  minProfitUsd:      userCfg.minProfitUsd      ?? 500,       // Min profit in USD before executing
  maxSlippagePct:    userCfg.maxSlippagePct    ?? 1.0,       // Max allowed slippage %
  minRoiMultiplier:  userCfg.minRoiMultiplier  ?? 100,       // Min ROI multiplier (e.g. 100x)
  inputAmountUsdc:   userCfg.inputAmountUsdc   ?? 0.2,       // USDC to use per arb attempt
  useFlashLoan:      userCfg.useFlashLoan      ?? false,     // Use Marginfi flash loan
  maxHops:           userCfg.maxHops           ?? 3,         // Max hops per route

  // ─ Jito
  jitoTipLamports:   userCfg.jitoTipLamports   ?? 100_000,  // Jito bundle tip

  // ─ Timing
  scanIntervalMs:    userCfg.scanIntervalMs    ?? 2_000,    // How often to scan (ms)
  execTimeoutMs:     userCfg.execTimeoutMs     ?? 30_000,   // Tx confirmation timeout

  // ─ Pool screening (from Meridian)
  minTvl:            userCfg.minTvl            ?? 5_000,    // Min pool TVL
  minFeeActiveTvlRatio: userCfg.minFeeActiveTvlRatio ?? 0.02,
  minOrganic:        userCfg.minOrganic        ?? 50,

  // ─ Telegram (optional)
  telegramBotToken:  process.env.TELEGRAM_BOT_TOKEN || userCfg.telegramBotToken || "",
  telegramChatId:    process.env.TELEGRAM_CHAT_ID   || userCfg.telegramChatId   || "",

  // ─ AI Agent (OpenRouter)
  openRouterApiKey:    process.env.OPENROUTER_API_KEY || userCfg.openRouterApiKey || "",
  agentModel:          userCfg.agentModel          ?? "anthropic/claude-3.5-haiku",  // model untuk reasoning
  agentIntervalMs:     userCfg.agentIntervalMs     ?? 30_000,  // seberapa sering agent reasoning (ms)
  agentEnabled:        userCfg.agentEnabled        ?? true,    // aktifkan/matikan agent
  agentMaxTokens:      userCfg.agentMaxTokens      ?? 1000,    // max token per reasoning cycle
  agentConfidenceMin:  userCfg.agentConfidenceMin  ?? 70,      // min confidence score (0-100) untuk execute

  // ─ Known pool addresses on Solana mainnet
  pools: {
    // Meteora DAMM v2 program
    DAMM_V2_PROGRAM: "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
    // Meteora DLMM program
    DLMM_PROGRAM:    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    // Orca Whirlpool program
    ORCA_PROGRAM:    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  },

  // ─ Route discovery
  baseTokens:        userCfg.baseTokens        ?? ["USDC", "SOL"],  // start/end of arb routes
  maxHops:           userCfg.maxHops           ?? 3,                // max hops per route (2/3/4)
  inputAmountUsdc:   userCfg.inputAmountUsdc   ?? 0.2,              // input per arb (in base token units)
  inputAmountSol:    userCfg.inputAmountSol    ?? 0.001,            // SOL input when base=SOL
  routeScanLimit:    userCfg.routeScanLimit    ?? 100,              // max pools to pull from Meteora
};

export default CONFIG;
