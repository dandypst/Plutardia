// state.js — Opportunity registry (adopted from Meridian state.js)
// Persists discovered opportunities and execution history to state.json

import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE  = path.join(__dirname, "state.json");

function load() {
  if (!existsSync(STATE_FILE)) {
    return { opportunities: [], execHistory: [], startedAt: Date.now() };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { opportunities: [], execHistory: [], startedAt: Date.now() };
  }
}

function save(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let _state = load();

export const state = {
  // ── Opportunities ─────────────────────────────────────────
  addOpportunity(opp) {
    _state.opportunities.unshift({ ...opp, id: Date.now(), seenAt: new Date().toISOString() });
    if (_state.opportunities.length > 500) _state.opportunities = _state.opportunities.slice(0, 500);
    save(_state);
  },

  getOpportunities(limit = 20) {
    return _state.opportunities.slice(0, limit);
  },

  getProfitableHistory(minProfit = 0) {
    return _state.execHistory.filter(e => e.success && e.profit >= minProfit);
  },

  // ── Execution history ─────────────────────────────────────
  recordExec(result) {
    _state.execHistory.unshift({ ...result, at: new Date().toISOString() });
    if (_state.execHistory.length > 200) _state.execHistory = _state.execHistory.slice(0, 200);
    save(_state);
  },

  getTotalProfit() {
    return _state.execHistory
      .filter(e => e.success)
      .reduce((sum, e) => sum + (e.profit || 0), 0);
  },

  getWinRate() {
    const total = _state.execHistory.length;
    if (!total) return 0;
    const wins = _state.execHistory.filter(e => e.success).length;
    return (wins / total * 100).toFixed(1);
  },

  // ── Full state summary ────────────────────────────────────
  summary() {
    return {
      totalExecs:   _state.execHistory.length,
      wins:         _state.execHistory.filter(e => e.success).length,
      totalProfit:  this.getTotalProfit().toFixed(2),
      winRate:      this.getWinRate() + "%",
      uptime:       Math.floor((Date.now() - _state.startedAt) / 60000) + " min",
    };
  },
};

export default state;
