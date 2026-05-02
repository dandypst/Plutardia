// tools/flashloan.js — Marginfi flash loan integration
// Allows zero-capital arbitrage: borrow USDC → arb → repay in same tx

import {
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { getConnection } from "./wallet.js";
import logger from "../logger.js";
import CONFIG from "../config.js";

// Marginfi program (mainnet)
const MARGINFI_PROGRAM = new PublicKey("MFv2hWf31Z9kbCa1snEPdcgx8RN5FMoLDs2MEjAAW8qX");
const MARGINFI_GROUP   = new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8");

// Known Marginfi USDC bank (mainnet)
const USDC_BANK = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHed47W");

// ─────────────────────────────────────────────────────────────
// NOTE: Full Marginfi flash loan requires the marginfi-client
// SDK (@mrgnlabs/marginfi-client-v2). This is a structural
// implementation showing how to integrate it.
// Install: npm install @mrgnlabs/marginfi-client-v2
// ─────────────────────────────────────────────────────────────

export class FlashLoan {
  constructor({ amountUsdc }) {
    this.amountUsdc    = amountUsdc;
    this.amountRaw     = Math.floor(amountUsdc * 1e6);
    this.available     = false;
    this.connection    = getConnection();
  }

  // Check if flash loans are available / enabled
  async init() {
    if (!CONFIG.useFlashLoan) {
      logger.dim("Flash loans disabled in config (useFlashLoan=false)");
      return false;
    }

    try {
      // Attempt to dynamically import marginfi SDK
      const { MarginfiClient, getConfig } = await import("@mrgnlabs/marginfi-client-v2");
      this.MarginfiClient = MarginfiClient;
      this.getConfig      = getConfig;
      this.available      = true;
      logger.info(`Flash loan ready: $${this.amountUsdc} USDC via Marginfi`);
      return true;
    } catch {
      logger.warn("Marginfi SDK not installed — flash loans disabled");
      logger.warn("To enable: npm install @mrgnlabs/marginfi-client-v2");
      this.available = false;
      return false;
    }
  }

  // Build flash loan + arb + repay instruction set
  // Instructions: [flashBorrowIx, ...arbIxs, flashRepayIx]
  async buildFlashLoanTxInstructions(walletKeypair, arbInstructions) {
    if (!this.available) return null;

    try {
      const cfg    = this.getConfig("production");
      const client = await this.MarginfiClient.fetch(cfg, walletKeypair, this.connection);

      // Get or create marginfi account
      const accounts = await client.getMarginfiAccountsForAuthority();
      const mfAcct   = accounts[0] || await client.createMarginfiAccount();

      // Build flash borrow ix
      const borrowIx = await mfAcct.makeFlashLoanBeginIx(USDC_BANK, this.amountRaw);

      // Calculate repay amount (principal + flash fee ~0.09%)
      const flashFeeBps  = 9; // Marginfi 0.09% fee
      const repayAmount  = Math.ceil(this.amountRaw * (1 + flashFeeBps / 10000));
      const repayIx      = await mfAcct.makeFlashLoanEndIx(USDC_BANK, repayAmount);

      logger.exec(`Flash loan: borrow $${this.amountUsdc}, repay $${repayAmount / 1e6} (fee: ${flashFeeBps}bps)`);

      return [borrowIx, ...arbInstructions, repayIx];
    } catch (e) {
      logger.error(`Flash loan build error: ${e.message}`);
      return null;
    }
  }

  // Calculate net profit after flash loan fee
  netProfit(grossProfitUsdc) {
    if (!this.available) return grossProfitUsdc;
    const flashFee = this.amountUsdc * 0.0009; // 0.09%
    return grossProfitUsdc - flashFee;
  }
}

export default FlashLoan;
