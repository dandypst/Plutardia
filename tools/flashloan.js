// tools/flashloan.js — Marginfi flash loan integration
// Allows zero-capital arbitrage: borrow USDC → arb → repay in same tx
// NOTE: Flash loans disabled by default (useFlashLoan=false in config)

import { getConnection } from "./wallet.js";
import logger from "../logger.js";
import CONFIG from "../config.js";

// Addresses resolved lazily (not at module load) to avoid PublicKey errors
const MARGINFI_ADDRESSES = {
  PROGRAM:   "MFv2hWf31Z9kbCa1snEPdcgx8RN5FMoLDs2MEjAAW8qX",
  GROUP:     "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8",
  USDC_BANK: "2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHed47W",
};

// ─────────────────────────────────────────────────────────────
// NOTE: Full Marginfi flash loan requires the marginfi-client
// SDK (@mrgnlabs/marginfi-client-v2). This is a structural
// implementation showing how to integrate it.
// Install: npm install @mrgnlabs/marginfi-client-v2
// ─────────────────────────────────────────────────────────────

export class FlashLoan {
  constructor({ amountUsdc }) {
    this.amountUsdc = amountUsdc;
    this.amountRaw  = Math.floor(amountUsdc * 1e6);
    this.available  = false;
    this.connection = getConnection();
  }

  async init() {
    if (!CONFIG.useFlashLoan) {
      logger.dim("Flash loans disabled (useFlashLoan=false)");
      return false;
    }

    try {
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

  async buildFlashLoanTxInstructions(walletKeypair, arbInstructions) {
    if (!this.available) return null;

    try {
      const { PublicKey } = await import("@solana/web3.js");
      const usdcBank = new PublicKey(MARGINFI_ADDRESSES.USDC_BANK);

      const cfg    = this.getConfig("production");
      const client = await this.MarginfiClient.fetch(cfg, walletKeypair, this.connection);

      const accounts = await client.getMarginfiAccountsForAuthority();
      const mfAcct   = accounts[0] || await client.createMarginfiAccount();

      const borrowIx    = await mfAcct.makeFlashLoanBeginIx(usdcBank, this.amountRaw);
      const flashFeeBps = 9;
      const repayAmount = Math.ceil(this.amountRaw * (1 + flashFeeBps / 10000));
      const repayIx     = await mfAcct.makeFlashLoanEndIx(usdcBank, repayAmount);

      logger.exec(`Flash loan: borrow $${this.amountUsdc}, repay $${repayAmount / 1e6}`);
      return [borrowIx, ...arbInstructions, repayIx];
    } catch (e) {
      logger.error(`Flash loan build error: ${e.message}`);
      return null;
    }
  }

  netProfit(grossProfitUsdc) {
    if (!this.available) return grossProfitUsdc;
    const flashFee = this.amountUsdc * 0.0009;
    return grossProfitUsdc - flashFee;
  }
}

export default FlashLoan;
