# Plutardia

**Autonomous Solana arbitrage bot — menemukan dan mengeksekusi route arbitrase paling menguntungkan di seluruh jaringan Solana.**

Inspired by the Meridian architecture. Filosofi: tiny input (USDC/SOL) → exploit price discrepancy antar pool → profit besar.

---

## How it works

```
Bot discovers ALL liquid pools on Meteora
  → Builds every possible route combination (USDC/SOL base)
  → Simulates each via Jupiter real-time quotes
  → AI agent reasons: layak dieksekusi? token aman?
  → Execute via Jito atomic bundle
```

Tidak ada route yang di-hardcode. Bot menemukan sendiri token dan route terbaik dari ribuan pool yang ada di Solana.

---

## Architecture

| File | Role |
|------|------|
| `index.js` | Main entry: REPL + cron + Telegram |
| `scanner.js` | Scan loop: discover pools → build routes → simulate |
| `agent.js` | Autonomous ReAct AI agent: screening + decide + execute |
| `executor.js` | Build swap txs, slippage guard, kirim via Jito bundle |
| `config.js` | Runtime config dari `.env` + `user-config.json` |
| `state.js` | Opportunity registry + execution history |
| `logger.js` | Color-coded terminal + file logger (`logs/plutardia.log`) |
| `telegram.js` | Telegram bot: alerts + command interface |
| `tools/wallet.js` | Keypair loader, SOL/token balances |
| `tools/dlmm.js` | Meteora DLMM SDK wrapper + pool screening API |
| `tools/jupiter.js` | Jupiter quote + swap tx builder |
| `tools/jito.js` | Jito bundle builder + submission + status polling |
| `tools/flashloan.js` | Marginfi flash loan (opsional, zero-capital arb) |
| `tools/token_registry.js` | Dynamic token resolver — auto-discover token dari pools |
| `tools/route_builder.js` | Build + simulate SEMUA kombinasi route dari pool aktif |
| `tools/definitions.js` | Tool schemas (OpenAI function calling format) |
| `tools/tool_executor.js` | Tool dispatcher — maps agent tool calls ke fungsi nyata |

---

## Requirements

- Node.js 18+
- Solana wallet dengan SOL untuk fees (≥ 0.01 SOL)
- USDC dan/atau SOL balance (atau aktifkan flash loan)
- Helius RPC key — [helius.dev](https://helius.dev) (gratis tier cukup)
- OpenRouter API key — [openrouter.ai](https://openrouter.ai) (untuk AI agent)
- Telegram bot token (opsional) — [@BotFather](https://t.me/BotFather)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure
cp .env.example .env
cp user-config.example.json user-config.json
# Edit kedua file dengan key kamu

# 3. Jalankan dalam dry mode dulu (tidak ada tx nyata)
npm run dev

# 4. Setelah yakin, set DRY_RUN=false untuk live trading
npm start
```

---

## .env Reference

| Variable | Wajib | Keterangan |
|----------|-------|------------|
| `RPC_URL` | ✅ | Solana RPC endpoint. Rekomendasi [Helius](https://helius.dev) |
| `HELIUS_API_KEY` | ✅ | API key dari Helius |
| `WALLET_PRIVATE_KEY` | ✅ | Private key wallet format **base58** (export dari Phantom/Solflare) |
| `DRY_RUN` | ✅ | `true` = simulasi tanpa tx nyata. Set `false` saat siap live |
| `OPENROUTER_API_KEY` | ✅* | API key dari [OpenRouter](https://openrouter.ai). *Wajib jika `agentEnabled=true` |
| `TELEGRAM_BOT_TOKEN` | ❌ | Token bot dari [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | ❌ | Bisa kosong — bot auto-detect saat kamu kirim pesan pertama |

```env
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_HELIUS_KEY
WALLET_PRIVATE_KEY=YOUR_BASE58_PRIVATE_KEY
DRY_RUN=true
OPENROUTER_API_KEY=sk-or-...
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## Config Reference (`user-config.json`)

| Field | Default | Keterangan |
|-------|---------|------------|
| `dryRun` | `true` | Simulasi tanpa tx nyata |
| `baseTokens` | `["USDC","SOL"]` | Token start/end untuk semua route |
| `maxHops` | `3` | Max hop per route (2/3/4) — makin tinggi makin banyak kombinasi |
| `inputAmountUsdc` | `0.2` | USDC input per arb attempt |
| `inputAmountSol` | `0.001` | SOL input per arb attempt |
| `routeScanLimit` | `100` | Max pool yang di-pull dari Meteora per scan |
| `minProfitUsd` | `500` | Minimum profit (USD) sebelum eksekusi |
| `maxSlippagePct` | `1.0` | Max slippage per hop (%) |
| `minRoiMultiplier` | `100` | Min ROI multiplier (mis. 100 = output 100x input) |
| `minTvl` | `5000` | Min TVL pool yang dipertimbangkan |
| `useFlashLoan` | `false` | Pakai Marginfi flash loan (zero capital) |
| `jitoTipLamports` | `100000` | Jito bundle tip |
| `scanIntervalMs` | `2000` | Frekuensi scan (ms) |
| `agentEnabled` | `true` | Aktifkan AI agent |
| `agentModel` | `anthropic/claude-3.5-haiku` | Model OpenRouter |
| `agentIntervalMs` | `30000` | Interval AI reasoning (ms) — bebas diatur |
| `agentMaxTokens` | `1000` | Max token per reasoning cycle |
| `agentConfidenceMin` | `70` | Min confidence score (0–100) untuk eksekusi |

---

## AI Agent

Plutardia menggunakan autonomous ReAct agent yang berjalan **independen** dari scanner — dia aktif menemukan route sendiri, bukan hanya menilai hasil scanner.

### Flow tiap cycle

```
Agent cycle #N:
  1. scan_all_routes()      → discover semua pool aktif, build SEMUA route kombinasi,
                              simulasi via Jupiter, return ranked by profit
  2. get_token_info()       → cek apakah token verified, cek risiko
  3. get_wallet_status()    → konfirmasi saldo cukup
  4. execute_arb()          → eksekusi route terbaik jika layak
```

### Tools agent

| Tool | Fungsi |
|------|--------|
| `scan_all_routes` | **Tool utama** — discover + build + simulate SEMUA route di Solana |
| `simulate_route` | Simulasi route spesifik (symbols atau mint address) |
| `screen_pools` | Raw pool data dari Meteora (TVL, volume, fee) |
| `compare_pool_prices` | Bandingkan harga token di beberapa pool sekaligus |
| `get_token_info` | Cek token: verified, decimals, harga, tags |
| `get_wallet_status` | Saldo SOL + USDC saat ini |
| `get_execution_history` | History eksekusi — agent bisa belajar dari masa lalu |
| `execute_arb` | Eksekusi route via Jito bundle |

### Model rekomendasi (OpenRouter)

| Model | Karakteristik |
|-------|---------------|
| `anthropic/claude-3.5-haiku` | Cepat & murah — bagus untuk reasoning rutin |
| `anthropic/claude-3.5-sonnet` | Lebih dalam — untuk analisis kompleks |
| `openai/gpt-4o-mini` | Alternatif murah |
| `google/gemini-flash-1.5` | Sangat cepat |

### Dua loop independen

```
Scanner  [tiap scanIntervalMs]   → discover pools → simulate routes → log results
Agent    [tiap agentIntervalMs]  → scan_all_routes() → reason → execute autonomously
```

Agent tidak bergantung pada scanner. Keduanya menemukan opportunity secara independen.

---

## REPL Commands

```
start           Start bot (scanner + AI agent)
stop            Stop bot
scan            Manual one-time scan
auto on/off     Toggle auto-execute rule-based (saat agent disabled)
exec <name>     Manual execute opportunity tertentu
status          Wallet balance + bot stats
agent           AI agent stats (cycles, tool calls, model, interval)
chat <msg>      Chat langsung dengan AI agent (akses penuh ke semua tools)
history         Recent opportunities
config          Show current config
help            Daftar commands
exit            Shutdown
```

---

## Telegram Commands

```
/start          Start bot
/stop           Stop bot
/status         Wallet + stats
/autoexec on    Enable auto-execute
/autoexec off   Disable auto-execute
/profit         Total profit sesi ini
```

---

## ⚠ Disclaimer

Software ini disediakan apa adanya. Menjalankan arbitrage bot mengandung risiko finansial nyata — kamu bisa kehilangan dana. Selalu mulai dengan `DRY_RUN=true`. Pahami apa yang kamu lakukan sebelum go live. Ini bukan saran finansial.
