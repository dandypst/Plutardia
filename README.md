# Plutardia

**Plutardia — Solana arbitrage bot — exploits price discrepancies between Meteora DAMM v2 and DLMM pools.**

Inspired by the Meridian architecture. Targets the same strategy visible in the source tweet:  
tiny USDC input → inflated DAMM v2 price → sell to DLMM → massive USDC return.

---

## How it works

```
$0.20 USDC
  → swap to ANX via Meteora DAMM v2   (over-inflated price)
  → swap ANX to ANB via Meteora DAMM v2
  → swap ANB to USDC via Meteora DLMM  (market price)
  = $400,000+ USDC
```

The bot continuously scans pool price discrepancies. When a profitable route is found:
1. Quotes are fetched from Jupiter for each hop
2. Slippage is checked before execution
3. All swaps are bundled atomically via **Jito** (no partial execution risk)
4. Optional **Marginfi flash loan** for zero-capital execution

---

## Architecture (from Meridian)

| File | Role |
|------|------|
| `index.js` | Main entry: REPL + cron + Telegram polling |
| `scanner.js` | Scans routes, discovers pools via Meteora API |
| `executor.js` | Builds swap txs, slippage checks, Jito bundle submission |
| `config.js` | Runtime config from `.env` + `user-config.json` |
| `state.js` | Opportunity registry + execution history |
| `logger.js` | Color-coded terminal + file logger |
| `telegram.js` | Telegram bot: alerts + command interface |
| `tools/wallet.js` | Keypair loader, SOL/token balances |
| `tools/dlmm.js` | Meteora DLMM SDK wrapper, pool screening |
| `tools/jupiter.js` | Jupiter quote + swap tx builder |
| `tools/jito.js` | Jito bundle builder + submission + status polling |
| `tools/flashloan.js` | Marginfi flash loan integration |

---

## Requirements

- Node.js 18+
- Solana wallet with SOL for fees (≥ 0.01 SOL)
- USDC balance (or Marginfi flash loan enabled)
- Helius RPC key (recommended) — [helius.dev](https://helius.dev)
- Telegram bot token (optional) — [@BotFather](https://t.me/BotFather)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
cp user-config.example.json user-config.json
# Edit both files with your keys

# 3. Run (dry mode — no real txs)
npm run dev

# 4. When ready for live trading
# Set DRY_RUN=false in .env
npm start
```

---

## .env Reference

| Variable | Wajib | Keterangan |
|----------|-------|------------|
| `RPC_URL` | ✅ | Solana RPC endpoint. Rekomendasi [Helius](https://helius.dev) — lebih cepat dari public RPC |
| `HELIUS_API_KEY` | ✅ | API key dari Helius (gratis tier tersedia) |
| `WALLET_PRIVATE_KEY` | ✅ | Private key wallet dalam format **base58** (export dari Phantom/Solflare) |
| `DRY_RUN` | ✅ | `true` = simulasi tanpa tx nyata. Set `false` saat siap live |
| `OPENROUTER_API_KEY` | ✅* | API key dari [OpenRouter](https://openrouter.ai) untuk AI agent reasoning. *Wajib jika `agentEnabled=true` |
| `TELEGRAM_BOT_TOKEN` | ❌ | Token bot dari [@BotFather](https://t.me/BotFather) untuk notifikasi |
| `TELEGRAM_CHAT_ID` | ❌ | Bisa dikosongkan — bot auto-detect saat kamu kirim pesan pertama |

```env
# Solana RPC (Helius recommended for speed)
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY

# Your wallet private key (base58 encoded)
WALLET_PRIVATE_KEY=YOUR_BASE58_PRIVATE_KEY

# DRY RUN — set false only when ready to go live!
DRY_RUN=true

# AI Agent — OpenRouter (https://openrouter.ai)
OPENROUTER_API_KEY=sk-or-...

# Telegram (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## AI Agent

Plutardia menggunakan AI agent (via OpenRouter) untuk reasoning setiap cycle:

```
Scanner menemukan opportunity
  → Agent membaca: pool data, profit, price impact, history
  → Agent reasoning: "Apakah ini layak dieksekusi?"
  → Agent memutuskan: EXECUTE / SKIP / WAIT
  → Jika EXECUTE + confidence ≥ threshold → bot eksekusi via Jito
```

Agent berjalan pada interval terpisah dari scanner, bisa dikonfigurasi:

| Field (`user-config.json`) | Default | Keterangan |
|---------------------------|---------|------------|
| `agentEnabled` | `true` | Aktifkan/matikan agent |
| `agentModel` | `anthropic/claude-3.5-haiku` | Model OpenRouter yang dipakai |
| `agentIntervalMs` | `30000` | Interval reasoning dalam milidetik (30s = 30000) |
| `agentMaxTokens` | `1000` | Max token per reasoning cycle |
| `agentConfidenceMin` | `70` | Minimum confidence score (0–100) untuk eksekusi |

Model yang bisa dipakai di OpenRouter:
- `anthropic/claude-3.5-haiku` — cepat & murah, bagus untuk reasoning rutin
- `anthropic/claude-3.5-sonnet` — lebih pintar, cocok untuk analisis kompleks
- `openai/gpt-4o-mini` — alternatif murah
- `google/gemini-flash-1.5` — sangat cepat

---

## REPL Commands

```
start         Start bot (scan loop + AI agent)
stop          Stop bot
scan          Manual one-time scan
auto on/off   Toggle auto-execution (rule-based, saat agent disabled)
exec <name>   Manually execute a specific opportunity
status        Wallet balance + bot stats
agent         Show AI agent stats (cycles, model, interval)
chat <msg>    Chat langsung dengan AI agent
history       Recent opportunities found
config        Show current config
help          Command list
exit          Shutdown
```

---

## Telegram Commands

```
/start          Start bot
/stop           Stop bot
/status         Wallet + stats
/autoexec on    Enable auto-execute
/autoexec off   Disable auto-execute
/profit         Total profit so far
```

---

## Config Reference (`user-config.json`)

| Field | Default | Description |
|-------|---------|-------------|
| `dryRun` | `true` | Simulate without real txs |
| `minProfitUsd` | `500` | Minimum profit in USD to execute |
| `maxSlippagePct` | `1.0` | Max allowed slippage per hop |
| `minRoiMultiplier` | `50` | Min output/input ratio |
| `inputAmountUsdc` | `0.2` | USDC used per arb attempt |
| `useFlashLoan` | `false` | Use Marginfi flash loan |
| `jitoTipLamports` | `100000` | Jito bundle tip |
| `scanIntervalMs` | `2000` | Scan frequency (ms) |
| `minTvl` | `5000` | Min pool TVL to consider |

---

## ⚠ Disclaimer

This software is provided as-is. Running an arbitrage bot carries real financial risk — you can lose funds. Always start with `DRY_RUN=true`. Understand what you're doing before going live. This is not financial advice.
