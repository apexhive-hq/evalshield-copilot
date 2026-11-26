# evalshield-copilot

**Open-Core Futures & Prop-Firm Evaluation Risk Shield, CME Position Sizer, Post-Trade Discipline Journal & Hosted Cloud Pro API** (`$0` MIT Local Core Forever · Strictly Read-Only / Human-in-the-Loop).

`evalshield-copilot` computes prop-firm trailing drawdowns (`INTRADAY_TRAILING`, `EOD_TRAILING`, `STATIC`), soft Daily Loss Limit (`DLL`) buffers, ATR-normalized CME contract caps with automatic micro fallbacks (`ES -> MES`, `NQ -> MNQ`, `GC -> MGC`, `CL -> MCL`), consistency-cap headroom (`30%–50%`), session-discipline guards, SHA-256 deduplicated broker CSV FIFO parsing, and a 10,000–25,000 run evaluation Monte Carlo survival simulator.

> **Human-in-the-Loop Firewall:** Strictly read-only risk math and post-trade journaling. **Zero broker API keys, zero automated order placement, zero copy-trading, and zero directional trade signals.** Built for Topstep, Apex Trader Funding, MyFundedFutures (`MFFU`), and Tradeify evaluation rules.

---

## Architecture

```text
  Broker CSV Exports (Tradovate / NT8 / Rithmic / TradingView)
     │
     ▼
  ┌───────────────────────────────────────────────┐
  │ packages/journal (Node 24 node:sqlite)        │◄── Read-Only Webhook (/api/ingest/webhook)
  │ • WAL SQLite + SHA-256 fill deduplication     │    (HMAC-SHA256 verified, strict loopback +
  │ • FIFO execution pairing + tilt audit         │     EVALSHIELD_ALLOWED_ORIGINS CORS guard)
  └───────────────────┬───────────────────────────┘
                      │
                      ▼
  ┌───────────────────────────────────────────────┐
  │ packages/core (@evalshield/core)              │
  │ • Intraday / EOD / Static drawdown math       │
  │ • 8 CME contract specs + micro fallback       │
  │ • Offline Ed25519 entitlement verifier        │
  └─────────┬────────────────────┬────────────────┘
            │                    │
            ▼                    ▼
     apps/cli (evalshield)   apps/web (127.0.0.1:4200)
     • check / import /      • Live Shield & Sizer UI
       report / activate /   • CSV FIFO Scorecard
       serve                 • Unlimited Local MIT Profiles

  Hosted Cloud Pro API & Storefront (Cloudflare Workers + Durable Object + KV)
  • https://evalshield-copilot.apexhive-hq.workers.dev/
  • Base USDC (0x2105) EOA + ERC-1271 / EIP-6492 Smart Wallet -> TxClaimLockDO -> Ed25519
  • Non-bypassable server APIs: 25k Cloud Monte Carlo, CME Macro Blackouts,
    Canonical Firm Presets, SSRF-Guarded Discord/Telegram Risk Alert Relays
```

---

## Quickstart (`$0` MIT Local Core — Unlimited Local Profiles)

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

Configure `EVALSHIELD_ALLOWED_ORIGINS` if accessing the local server API from an explicit cross-origin dashboard origin (loopback `127.0.0.1` / `localhost` / `[::1]` is allowed automatically; disallowed cross-origin writes return `403 ORIGIN_NOT_ALLOWED`).

---

## Local MIT Core vs. Hosted Cloud Pro API

| Tier | Price (One-Time Base USDC) | Scope |
| --- | --- | --- |
| **MIT Local Core** | **`0 USDC`** | Unlimited local SQLite accounts, all drawdown modes, 8 CME contracts, 4 CSV FIFO adapters, CLI & local web dashboard forever |
| **Cloud Pro Solo** | **`29 USDC`** | Hosted Cloud API Bearer entitlement (`EVALSHIELD-PRO-v1...`): 25,000-run up to 20-account Cloud Monte Carlo (`/api/cloud/monte-carlo`), full CME FOMC/CPI/NFP blackout schedule & multipliers (`/api/cloud/blackout-calendar`), canonical rule presets (`/api/cloud/presets`), and SSRF-guarded Discord/Telegram risk alert relays (`/api/cloud/relay/alert`) |
| **Cloud Pro Team** | **`99 USDC`** | All Solo Cloud Pro endpoints + up to 100-account coaching-desk Cloud Monte Carlo stress tests & desk-wide exposure templates |

Store your Cloud Pro token locally for CLI / scripts:

```bash
node apps/cli/dist/src/cli.js activate --token "EVALSHIELD-PRO-v1.<payload>.<sig>"
```

Call Hosted Cloud Pro API endpoints using `Authorization: Bearer EVALSHIELD-PRO-v1...`:

```bash
# Public preview vs full Pro blackout rules
curl -H "Authorization: Bearer EVALSHIELD-PRO-v1.<payload>.<sig>" \
  https://evalshield-copilot.apexhive-hq.workers.dev/api/cloud/blackout-calendar

# Server-side 25,000-path Cloud Monte Carlo stress test
curl -X POST https://evalshield-copilot.apexhive-hq.workers.dev/api/cloud/monte-carlo \
  -H "Authorization: Bearer EVALSHIELD-PRO-v1.<payload>.<sig>" \
  -H "Content-Type: application/json" \
  -d '{"runs":25000,"accounts":4,"winRate":50,"rewardRiskRatio":1.6,"riskPerTradeUsd":250,"profitTargetUsd":3000,"maxDrawdownUsd":2000}'
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
4. **Local SQLite Journal & Hardened HTTP Server (`packages/journal` + `apps/web`):**
   - Content-hashed (`SHA-256`) fill ingestion prevents double-counting across overlapping CSV exports.
   - Formula-injection-safe CSV export (`/api/journal/export.csv`) prefixes leading `=`, `+`, `-`, `@`, tab, and carriage return cells cleanly.
   - Strict CORS (`Vary: Origin`, loopback + `EVALSHIELD_ALLOWED_ORIGINS`) and HMAC-SHA256 `timingSafeEqual` webhook verification (`/api/ingest/webhook`).
5. **Cloud Pro API & Non-Custodial Checkout (`storefront`):**
   - Verifies Base USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) transfers from both EOA (`EIP-191`) and Base Smart Contract Wallets (`ERC-1271` / `EIP-6492`) with atomic `TxClaimLockDO` Durable Object replay locking.

---

## Development & Verification

Workspace tests (`packages/core`, `packages/journal`, `apps/cli`):

```bash
pnpm install --ignore-scripts
pnpm run typecheck
pnpm test
```

Cloudflare Workers storefront + Cloud Pro E2E tests (`storefront`):

```bash
cd storefront
pnpm install --ignore-scripts
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
```

Local dashboard Playwright check (`apps/web`, after building workspace and installing Playwright Chromium in `storefront`):

```bash
cd apps/web && pnpm test
```

---

## License & Support

- Source Code: [MIT License](./LICENSE)
- Hosted Cloud Pro API: `https://evalshield-copilot.apexhive-hq.workers.dev/`
- Support: `apexhive.hq@proton.me`

If the open-source MIT tooling saves you an evaluation reset, optional Base USDC tips are welcome at `0x32eceaC45DBED9E555dAb80346aBd4Ab9C676206`.
