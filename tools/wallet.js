// tools/wallet.js — Wallet tools (SOL + token balances, keypair loader)
// Adopted from Meridian tools/wallet.js pattern

import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import bs58 from "bs58";
import CONFIG from "../config.js";
import logger from "../logger.js";

// ── Well-known mint addresses ────────────────────────────────
export const MINTS = {
  USDC: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  SOL:  new PublicKey("So11111111111111111111111111111111111111112"),
  // Add token mints as discovered
};

// ── Connection singleton ─────────────────────────────────────
let _connection = null;
export function getConnection() {
  if (!_connection) {
    const rpc = CONFIG.heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${CONFIG.heliusApiKey}`
      : CONFIG.rpcUrl;
    _connection = new Connection(rpc, { commitment: "confirmed" });
    logger.info(`RPC connected: ${rpc.slice(0, 50)}...`);
  }
  return _connection;
}

// ── Keypair loader ───────────────────────────────────────────
let _keypair = null;
export function getKeypair() {
  if (_keypair) return _keypair;
  if (!CONFIG.walletPrivateKey) {
    throw new Error("WALLET_PRIVATE_KEY not set in .env / user-config.json");
  }
  try {
    const bytes = bs58.decode(CONFIG.walletPrivateKey);
    _keypair = Keypair.fromSecretKey(bytes);
    logger.info(`Wallet loaded: ${_keypair.publicKey.toBase58().slice(0, 8)}...${_keypair.publicKey.toBase58().slice(-6)}`);
    return _keypair;
  } catch (e) {
    throw new Error(`Invalid private key: ${e.message}`);
  }
}

// ── SOL balance ──────────────────────────────────────────────
export async function getSolBalance(pubkey = null) {
  const conn = getConnection();
  const pk   = pubkey ? new PublicKey(pubkey) : getKeypair().publicKey;
  const lamports = await conn.getBalance(pk);
  const sol = lamports / LAMPORTS_PER_SOL;
  logger.dim(`SOL balance: ${sol.toFixed(6)} SOL`);
  return sol;
}

// ── SPL token balance ────────────────────────────────────────
export async function getTokenBalance(mintAddr, walletAddr = null) {
  const conn    = getConnection();
  const wallet  = walletAddr ? new PublicKey(walletAddr) : getKeypair().publicKey;
  const mint    = new PublicKey(mintAddr);

  try {
    const ata    = await getAssociatedTokenAddress(mint, wallet);
    const acct   = await getAccount(conn, ata);
    const amount = Number(acct.amount);
    return amount;
  } catch {
    return 0;
  }
}

// ── Full wallet status ───────────────────────────────────────
export async function getWalletStatus() {
  const kp   = getKeypair();
  const sol  = await getSolBalance();
  const usdc = await getTokenBalance(MINTS.USDC.toBase58());

  return {
    address: kp.publicKey.toBase58(),
    sol:     sol,
    usdc:    usdc / 1e6,  // USDC has 6 decimals
  };
}
