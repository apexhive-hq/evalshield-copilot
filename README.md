# evalshield-copilot

**Open-Core Futures & Prop-Firm Evaluation Risk Shield, CME Position Sizer, and Post-Trade Discipline Journal** (`MIT` Local Core `$0` Forever · Strictly Read-Only / Human-in-the-Loop).

`evalshield-copilot` computes prop-firm trailing drawdowns (`INTRADAY_TRAILING`, `EOD_TRAILING`, `STATIC`), soft Daily Loss Limit (`DLL`) buffers, ATR-normalized CME contract caps with automatic micro fallbacks (`ES -> MES`, `NQ -> MNQ`, `GC -> MGC`, `CL -> MCL`), consistency-cap headroom (`30%–50%`), session-discipline guards, SHA-256 deduplicated broker CSV FIFO parsing, and a 10,000-run evaluation Monte Carlo survival simulator.

> **Human-in-the-Loop Firewall:** Strictly read-only risk math and post-trade journaling. **Zero broker API keys, zero automated order placement, zero copy-trading, and zero directional trade signals.** Built for Topstep, Apex Trader Funding, MyFundedFutures (`MFFU`), and Tradeify evaluation rules.

---

## Architecture

```text
  Broker CSV Exports (Tradovate / NT8 / Rithmic / TradingView)
     │
     ▼
  ┌─────────────────────────────────────────┐
  │ packages/journal (Node 24 node:sqlite)  │◄── Read-Only Webhook (/api/ingest/webhook)
  │ • WAL SQLite + SHA-256 fill deduplication│    (HMAC-SHA256 timingSafeEqual verified)
  │ • FIFO execution pairing + tilt audit   │
  └───────────────────┬─────────────────────┘
                      │
                      ▼
  ┌─────────────────────────────────────────┐
  │ packages/core (@evalshield/core)        │
  │ • Intraday / EOD / Static drawdown math │
  │ • 8 CME contract specs + micro fallback │
  │ • Offline Ed25519 entitlement verifier  │
  └─────────┬────────────────────┬──────────┘
            │                    │
            ▼                    ▼
     apps/cli (evalshield)   apps/web (127.0.0.1:4200)
     • check / import /      • Live Shield & Sizer UI
       report / activate /   • CSV FIFO Scorecard
       serve                 • 10,000-Run Monte Carlo

  storefront/ (Cloudflare Worker + KV)
  • Client-side Prop Shield & 10,000-Run Monte Carlo preview
  • Non-custodial Base USDC (0x2105) -> EIP-191 -> Ed25519 license minting
```

---

## Quickstart (`$0` MIT Local Core)

Requires **Node.js `>= 24.0.0`** (uses built-in `node:sqlite` and `node:test`) and **pnpm `12+`**.

```bash
git clone https://github.com/apexhive-hq/evalshield-copilot.git
cd evalshield-copilot
pnpm install --ignore-scripts
pnpm run build
```

Run a pre-trade drawdown & CME sizing check:

```bash
node apps/cli/dist/src/cli.js check --preset topstep_50k --symbol ES --stop-ticks 16 --atr 4.5 --skip-globex
```

Import a broker CSV export (auto-detects `tradovate-fills`, `tradovate-perf`, `nt8-trades`, `nt8-execs`, `rithmic`, `tradingview`), inspect your discipline scorecard, or start the local web dashboard on `127.0.0.1:4200`:

```bash
node apps/cli/dist/src/cli.js import --file ./my-trades.csv --format auto
node apps/cli/dist/src/cli.js report
node apps/cli/dist/src/cli.js serve --port 4200
```

---

## Core Modules

1. **Drawdown & Trailing Floor Shield (`packages/core`):**
   - Models `INTRADAY_TRAILING` (real-time equity HWM tracking), `EOD_TRAILING` (session-close rollover), and `STATIC` floors, plus firm `lockCap` caps.
   - Applies soft `0.8 * DLL` guardrails and automatic `0.5x` risk downsizing inside `AMBER_CAUTION` zones.
2. **CME Volatility Sizing & Micro Fallback (`packages/core`):**
   - Pre-configured tick values and default round-trip commissions for `ES`, `MES`, `NQ`, `MNQ`, `GC`, `MGC`, `CL`, and `MCL`.
   - Computes effective stop `max(userStopTicks, ceil(k * ATR14 / tickSize))`, subtracts commission + slippage ticks, and recommends micro contracts when full-size contracts exceed safe runway.
3. **Session Quality & Tilt Breaker (`packages/core`):**
   - Evaluates Globex maintenance windows, economic event blackout buffers, ATR volatility expansion, burst overtrading, and `3`-loss tilt cooldowns (`GO`, `REDUCED_SIZE`, `STAND_DOWN`).
4. **Local SQLite Journal & Dashboard (`packages/journal` + `apps/web`):**
   - Content-hashed (`SHA-256`) fill ingestion prevents double-counting across overlapping CSV exports.
   - Formula-injection-safe CSV export (`/api/journal/export.csv`) prefixes leading `=`, `+`, `-`, `@`, tab, and carriage return cells cleanly.

---

## Open-Core Licensing Tiers

| Tier | Price (One-Time Base USDC) | Scope |
| --- | --- | --- |
| **MIT Local Core** | **`0 USDC`** | `1` active account forever, all drawdown modes, 8 CME contracts, 4 CSV FIFO adapters, CLI & local web dashboard |
| **Pro Solo Funded-Prep** | **`29 USDC`** | Up to `20` simultaneous eval/funded accounts, firm rule presets, webhook ATR ingestion, 10k Monte Carlo bootstrap |
| **Pro Team Coaching Desk** | **`99 USDC`** | Unlimited trader profiles & desk-wide exposure rollups with offline Ed25519 verification |

Activate an offline Ed25519 entitlement token (`EVALSHIELD-PRO-v1...`):

```bash
node apps/cli/dist/src/cli.js activate --token "EVALSHIELD-PRO-v1.<payload>.<sig>"
```

---

## Development & Verification

Workspace tests (`packages/core`, `packages/journal`, `apps/cli`):

```bash
pnpm run typecheck
pnpm test
```

Local dashboard Playwright check (`apps/web`):

```bash
cd apps/web && pnpm test
```

Cloudflare Workers storefront tests (`storefront`):

```bash
cd storefront
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
```

---

## License & Support

- Source Code: [MIT License](./LICENSE)
- Support: `apexhive.hq@proton.me`
