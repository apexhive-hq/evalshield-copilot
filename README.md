# evalshield-copilot (v3.0.2)

**Read-only risk shield, position sizer, and execution journal for prop-firm and futures traders.** Computes trailing drawdown floors, cross-market contract sizing, multi-account anti-hedge checks, macro news blackouts, and 25,000-run evaluation simulations locally without broker credentials or automated order execution.

## Core Modules

1. **Drawdown Guard** (`packages/core`): Tracks intraday trailing, end-of-day trailing, and static drawdown floors across Topstep, Apex, MFFU, FTMO, and Tradeify rules, with soft daily loss buffers, consistency headroom, and tilt cooldowns.
2. **Cross-Market Sizer** (`packages/core`): Converts stop distance, live spread/rollover R-drag, and 14-bar ATR into max contract and lot caps across CME Futures (`ES/MES/NQ/MNQ/GC/MGC/CL/MCL`), Spot Gold & FX (`XAUUSD/EURUSD`), and Perps (`BTC-PERP/ETH-PERP/SOL-PERP`), with micro contract fallbacks.
3. **Portfolio Anti-Hedge Check** (`packages/core`, `storefront/`): Flags opposite-direction positions across linked accounts and correlated `ES` + `NQ` beta exposure before entry.
4. **Trade Journal** (`packages/journal`): Local SQLite WAL execution ledger with pre-trade thesis snapshots, SHA-256 fill deduplication, Tradovate/NinjaTrader 8/Rithmic/TradingView CSV FIFO pairing, and formula-safe CSV export.
5. **Macro Event Calendar** (`storefront/`): Verified 2026–2027 FOMC, BLS CPI, and BLS NFP schedules converted with exact US Eastern DST rules, separating strict `±2m` order/SL/TP blackouts (FTMO) from funded-only restrictions (MFFU) and CME daily maintenance windows.
6. **25k Monte Carlo & Alert Webhook** (`storefront/`, `deploy/cloudflare-byo/`): Simulates 25,000 evaluation survival paths and dispatches pre-filtered risk alerts to Telegram or Discord (`deploy/cloudflare-byo/` for self-hosted Cron workers, or hosted relay for Team/Enterprise licenses).

> **Human-in-the-Loop Firewall:** Strictly read-only risk math, pre-trade/post-trade audit journaling, and passive feed monitoring (Polymarket Gamma API & Hyperliquid `/info`). Zero broker API keys, zero order placement, and zero X/Twitter scraping.

---

## Architecture (v3.0.2 — Cross-Market Rule-Based Risk Engine)

```text
  Broker CSV Exports (Tradovate / NT8 / Rithmic / TradingView) + Pre-Trade Thesis Audits
     │
     ▼
  ┌──────────────────────────────────────────────────────────┐
  │ packages/journal (Node 24 node:sqlite WAL)               │◄── Read-Only Webhook (/api/ingest/webhook)
  │ • Pre-trade snapshot + raw thesis (/api/journal/pretrade)│◄── BYO Pluggable Connectors (/api/connectors)
  │ • SHA-256 fill dedup + formula-safe CSV export           │    (SSRF-guarded RSS max-3 / Polymarket / Custom Asset)
  └───────────────────────────┬──────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────┐
  │ packages/core (@evalshield/core v3.0.2)                  │
  │ • Prop Presets: Topstep, Apex, MFFU, FTMO (1&2), Tradeify│
  │ • Assets: ES/MES/NQ/MNQ/GC/MGC/CL/MCL + XAUUSD/EURUSD +  │
  │           BTC-PERP / ETH-PERP / SOL-PERP + Custom Specs  │
  │ • XAUUSD Rollover Spread R-Drag + US/EU DST Mismatch     │
  │ • 85% Consistency Safe Headroom + Crypto Maker/Taker/Fund│
  │ • Portfolio Guard: ES+NQ Beta Multiplier & Anti-Hedge Ban│
  │ • No-Key Feeds: Polymarket Gamma API + Hyperliquid /info │
  └──────────────┬─────────────────────────┬─────────────────┘
                 │                         │
                 ▼                         ▼
       apps/cli (evalshield)         apps/web (127.0.0.1:4200)
       • check / pretrade / brief /  • 15s Pre-Market Brief Card
         portfolio-check / import /  • Cross-Market Risk Shield
         report / activate / serve   • Collapsible BYO Connectors

  Self-Host Alert Sentinel (deploy/cloudflare-byo/)
  • Runs on your own Cloudflare Workers account (BYOStateDO + */15 Cron)
  • Sends 15s Brief & pre-filtered TradingView webhook alerts to Telegram/Discord

  Public Sandbox & Commercial License Issuer (storefront/)
  • https://evalshield-copilot.apexhive-hq.workers.dev/
  • Analytical risk sandbox endpoints (25k Monte Carlo, Presets, Blackouts, Gamma/HL Brief)
  • Base USDC ERC-1271 / EIP-6492 + TxClaimLockDO -> Ed25519 Team/Enterprise Certificates
```

---

## Quickstart (Node 24)

Requires **Node.js `>= 24.0.0`** (uses built-in `node:sqlite` and `node:test`) and **pnpm `10+`**.

```bash
git clone https://github.com/apexhive-hq/evalshield-copilot.git
cd evalshield-copilot
pnpm install --ignore-scripts
pnpm run build
```

Run cross-market risk checks (`FTMO`, `Tradeify`, `Topstep`, `Apex`, `MFFU`), record pre-trade thesis snapshots, fetch the 15-second brief, and audit multi-account hedging:

```bash
node apps/cli/dist/src/cli.js check --preset ftmo_100k_1step --symbol XAUUSD --stop-ticks 200 --spread-ticks 75 --skip-globex
node apps/cli/dist/src/cli.js pretrade --symbol XAUUSD --side LONG --qty 1 --stop-ticks 200 --thesis "London sweep reclaim"
node apps/cli/dist/src/cli.js brief --slug fed-cut-december --coins BTC,ETH,SOL
node apps/cli/dist/src/cli.js import --file ./my-trades.csv --format auto
node apps/cli/dist/src/cli.js serve --port 4200
```

Want 24/7 Telegram or Discord alerts when your computer is off? Follow [`deploy/cloudflare-byo/README.md`](./deploy/cloudflare-byo/README.md) to deploy the alert sentinel onto your own Cloudflare Workers account.

---

## Verification

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
cd storefront && pnpm install --ignore-scripts && pnpm run typecheck && pnpm test
cd ../deploy/cloudflare-byo && pnpm install --ignore-scripts && pnpm run typecheck && pnpm test
cd ../../apps/web && pnpm test
```

## Licensing & Support

`evalshield-copilot` is licensed under the [ApexHive Dual Source-Available License](./LICENSE):
- **Solo local:** Free (`1` natural person — full local risk engine, SQLite journal, connectors, and `deploy/cloudflare-byo/` template)
- **Team:** `99 USDC` one-time on Base (`2–99` seats — Ed25519 organization certificate + hosted outbound Telegram/Discord relay)
- **Enterprise:** `499 USDC` one-time on Base (`100+` seats — organization-wide seats, redistribution entitlement, priority rule specs)

- Live Sandbox & Commercial Issuer: `https://evalshield-copilot.apexhive-hq.workers.dev/`
- Support: `apexhive.hq@proton.me`

Optional Solo community appreciation tips (Base USDC): `0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206`.
