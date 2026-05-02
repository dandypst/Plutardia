// get_status.js — Quick wallet + bot status (adopted from Meridian get_status.js)
import { getWalletStatus } from "./tools/wallet.js";
import { state } from "./state.js";
import logger from "./logger.js";

logger.banner("PLUTARDIA STATUS");

try {
  const wallet = await getWalletStatus();
  const stats  = state.summary();

  console.log(`
  Wallet:  ${wallet.address}
  SOL:     ${wallet.sol.toFixed(6)} SOL
  USDC:    $${wallet.usdc.toFixed(2)}

  ── Bot Stats ──────────────────────────
  Uptime:       ${stats.uptime}
  Total Execs:  ${stats.totalExecs}
  Wins:         ${stats.wins} (${stats.winRate})
  Total Profit: $${stats.totalProfit} USDC
  `);
} catch (e) {
  logger.error(e.message);
}
