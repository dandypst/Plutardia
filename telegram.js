// telegram.js — Telegram bot notifications (adopted from Meridian telegram.js)
// Sends arb alerts, profit summaries, and accepts commands

import axios from "axios";
import CONFIG from "./config.js";
import logger from "./logger.js";

let _chatId  = CONFIG.telegramChatId;
let _polling = false;
let _offset  = 0;

// ── Send message ─────────────────────────────────────────────
export async function sendMessage(text, chatId = _chatId) {
  if (!CONFIG.telegramBotToken || !chatId) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML" },
      { timeout: 5000 }
    );
  } catch (e) {
    logger.warn(`Telegram send failed: ${e.message}`);
  }
}

// ── Canned notification messages ─────────────────────────────
export function notifyArbFound(opp) {
  const emoji = opp.profitUsdc > 10000 ? "🔥🔥🔥" : "🔥";
  const msg = `${emoji} <b>ARB FOUND</b>
Route: <code>${opp.routeName}</code>
Input: <b>$${opp.inputUsdc.toFixed(4)}</b> USDC
Output: <b>$${opp.outputUsdc.toFixed(2)}</b> USDC
Profit: <b>$${opp.profitUsdc.toFixed(2)}</b> (+${opp.roiMultiplier.toFixed(0)}x)`;
  return sendMessage(msg);
}

export function notifyExecSuccess(result) {
  const msg = `✅ <b>ARB SUCCESS</b>
Bundle: <code>${result.bundleId}</code>
Profit: <b>$${result.profit.toFixed(2)} USDC</b>`;
  return sendMessage(msg);
}

export function notifyExecFailed(error) {
  return sendMessage(`❌ <b>ARB FAILED</b>\n${error}`);
}

export function notifySummary(stats) {
  const msg = `📊 <b>Hourly Summary</b>
Scans: ${stats.scans}
Found: ${stats.found}
Executed: ${stats.total}
Wins: ${stats.success} (${stats.winRate}%)
Total Profit: <b>$${stats.totalProfit.toFixed(2)}</b>`;
  return sendMessage(msg);
}

// ── Poll for incoming commands ────────────────────────────────
export function startPolling(onCommand) {
  if (!CONFIG.telegramBotToken) return;
  _polling = true;
  logger.info("Telegram polling started");

  async function poll() {
    if (!_polling) return;
    try {
      const resp = await axios.get(
        `https://api.telegram.org/bot${CONFIG.telegramBotToken}/getUpdates`,
        { params: { offset: _offset, timeout: 20 }, timeout: 25000 }
      );

      const updates = resp.data?.result || [];
      for (const upd of updates) {
        _offset = upd.update_id + 1;

        // Auto-register chat on first message
        if (!_chatId && upd.message?.chat?.id) {
          _chatId = upd.message.chat.id.toString();
          logger.info(`Telegram chat registered: ${_chatId}`);
          await sendMessage("🤖 <b>Meteora Arb Bot connected!</b>\n\nCommands:\n/status — wallet & stats\n/stop — stop bot\n/start — start bot\n/profit — total profit");
        }

        const text = upd.message?.text || "";
        if (text && onCommand) {
          await onCommand(text.trim(), _chatId);
        }
      }
    } catch (e) {
      if (!e.message.includes("timeout")) {
        logger.warn(`Telegram poll error: ${e.message}`);
      }
    }

    if (_polling) setTimeout(poll, 1000);
  }

  poll();
}

export function stopPolling() {
  _polling = false;
}
