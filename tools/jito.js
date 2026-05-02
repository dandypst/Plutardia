// tools/jito.js — Jito MEV bundle builder
// Bundles all swap legs into a single atomic Jito bundle for guaranteed execution

import {
  Connection,
  Transaction,
  VersionedTransaction,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import axios from "axios";
import bs58 from "bs58";
import logger from "../logger.js";
import CONFIG from "../config.js";

// Jito block engine endpoints (mainnet)
const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.labs.io",
  "https://amsterdam.mainnet.block-engine.jito.labs.io",
  "https://frankfurt.mainnet.block-engine.jito.labs.io",
  "https://ny.mainnet.block-engine.jito.labs.io",
  "https://tokyo.mainnet.block-engine.jito.labs.io",
];

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt13BNxd4",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL1KHK",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function randomTipAccount() {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

// ── Add Jito tip instruction to a transaction ────────────────
export function buildTipInstruction(fromPubkey, tipLamports = CONFIG.jitoTipLamports) {
  return SystemProgram.transfer({
    fromPubkey,
    toPubkey: new PublicKey(randomTipAccount()),
    lamports: tipLamports,
  });
}

// ── Send a Jito bundle ───────────────────────────────────────
export async function sendJitoBundle(serializedTxs) {
  // serializedTxs: array of base58 encoded signed transactions
  const endpoint = JITO_ENDPOINTS[Math.floor(Math.random() * JITO_ENDPOINTS.length)];
  const url      = `${endpoint}/api/v1/bundles`;

  logger.exec(`Sending Jito bundle (${serializedTxs.length} txs) to ${endpoint.split("//")[1].split(".")[0]}`);

  if (CONFIG.dryRun) {
    logger.warn("[DRY RUN] Jito bundle NOT sent — would have sent:");
    serializedTxs.forEach((tx, i) => logger.dim(`  tx[${i}]: ${tx.slice(0, 40)}...`));
    return { bundleId: "dry-run-" + Date.now() };
  }

  try {
    const resp = await axios.post(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [serializedTxs],
      },
      { headers: { "Content-Type": "application/json" }, timeout: 15_000 }
    );

    if (resp.data.error) {
      throw new Error(resp.data.error.message || JSON.stringify(resp.data.error));
    }

    const bundleId = resp.data.result;
    logger.success(`Jito bundle submitted: ${bundleId}`);
    return { bundleId };
  } catch (e) {
    logger.error(`Jito bundle error: ${e.message}`);
    throw e;
  }
}

// ── Poll Jito bundle status ──────────────────────────────────
export async function getBundleStatus(bundleId) {
  const endpoint = JITO_ENDPOINTS[0];
  try {
    const resp = await axios.post(
      `${endpoint}/api/v1/bundles`,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getBundleStatuses",
        params: [[bundleId]],
      },
      { timeout: 10_000 }
    );

    const statuses = resp.data?.result?.value || [];
    return statuses[0] || null;
  } catch {
    return null;
  }
}

// ── Wait for bundle confirmation ─────────────────────────────
export async function waitForBundle(bundleId, timeoutMs = CONFIG.execTimeoutMs) {
  const start = Date.now();
  logger.exec(`Waiting for bundle: ${bundleId}`);

  while (Date.now() - start < timeoutMs) {
    const status = await getBundleStatus(bundleId);
    if (status) {
      const s = status.confirmation_status;
      if (s === "confirmed" || s === "finalized") {
        logger.success(`Bundle confirmed: ${bundleId} [${s}]`);
        return { confirmed: true, status: s, transactions: status.transactions };
      }
      if (s === "failed") {
        logger.error(`Bundle failed: ${bundleId}`);
        return { confirmed: false, status: s };
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  logger.error(`Bundle timeout after ${timeoutMs / 1000}s: ${bundleId}`);
  return { confirmed: false, status: "timeout" };
}
