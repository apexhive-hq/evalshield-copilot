# evalshield-copilot (v3.0.2)

**Full-Open Cross-Market Prop-Firm Risk Shield, Multi-Account Anti-Hedge Guard, Pre-Trade Thesis Journal & 1-Click Self-Host BYO Cloud Kit** (`0 USDC` Solo Forever · Strictly Read-Only / Human-in-the-Loop).

`evalshield-copilot` uses the **ApexHive Dual Source-Available License (Solo-Free / Commercial Seat Model)**:
- **Single Traders (`Solo — 1 person`)** get **100% of the rule-based risk evaluation engine free forever (`0 USDC`)** — zero HWID locks, zero 24h trial countdowns, zero feature paywalls, plus a `$0` 1-click Cloudflare self-host Cron template (`deploy/cloudflare-byo/`).
- **Teams & Organizations (`2+` seats)** purchase an official commercial Ed25519 certificate verified on Base Mainnet USDC (`Team 2–99 seats: Founder Early-Bird 99 USDC` · `Enterprise 100+ seats: Founder Early-Bird 499 USDC`).

> **Human-in-the-Loop Firewall:** Strictly read-only risk mathematics, pre-trade/post-trade audit journaling, and passive feed monitoring. **Zero X/Twitter scraping, zero automated order placement or copy-trade execution, zero geo-blocked Binance/Bybit dependencies, and concise 15-second cards instead of bloated news walls.**

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

  1-Click Solo Self-Host Sentinel (deploy/cloudflare-byo/)
  • Deploy on YOUR OWN $0 Cloudflare Workers account in 5 min (BYOStateDO + */15 Cron)
  • 24/7 Telegram/Discord 15s Brief & TradingView Pre-Filtered Alerts with $0 server cost

  Public Sandbox & Commercial License Issuer (storefront/)
  • https://evalshield-copilot.apexhive-hq.workers.dev/
  • All analytical tools open at $0 (25k Monte Carlo, Presets, Blackouts, Gamma/HL Brief)
  • Base USDC ERC-1271 / EIP-6492 + TxClaimLockDO -> Ed25519 Team/Enterprise Certificates
```

---

## Licensing (ApexHive Dual License — Solo $0 · Early-Bird Commercial)

| Tier | Eligibility | Price (One-Time Base USDC) | Scope |
| --- | --- | --- | --- |
| **Solo Personal** | `1` natural person | **`0 USDC`** | **Full rule-based risk engine**, unlimited local accounts, BYO connectors, Portfolio Guard, public 25k sandbox, and `deploy/cloudflare-byo/` self-host kit forever |
| **Commercial Team** | `2–99` seats (coaching rooms / trading desks) | **`Founder Early-Bird 99 USDC`** | Official Ed25519 organization license + hosted outbound Telegram/Discord relay endpoint |
| **Commercial Enterprise** | `100+` seats (prop firms / funds / white-label) | **`Founder Early-Bird 499 USDC`** | Organization-wide unlimited seats, custom SLA support, & commercial redistribution entitlement |

---

## Quickstart (`0 USDC` Solo — Node 24)

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

Want 24/7 Telegram/Discord red-zone & morning brief alerts when your computer is off? Follow [`deploy/cloudflare-byo/README.md`](./deploy/cloudflare-byo/README.md) to deploy onto **your own `$0` Cloudflare account** in 5 minutes.

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

## License & Support

- License: [ApexHive Dual Source-Available License](./LICENSE)
- Live Sandbox & Commercial Issuer: `https://evalshield-copilot.apexhive-hq.workers.dev/`
- Support: `apexhive.hq@proton.me`

Optional Solo community appreciation tips (Base USDC): `0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206`.
