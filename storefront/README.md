# evalshield-copilot Open Risk Sandbox & Commercial License Issuer

Cloudflare Workers + Durable Object (`TxClaimLockDO`) + KV service powering:

- **Open Risk Analytical Sandbox (`0 USDC` Forever for Solo Traders):**
  - `GET /api/cloud/blackout-calendar` — Verified 2026–2027 FOMC/CPI/NFP schedules with exact US Eastern DST conversion, FTMO strict `±2m` SL/TP ban vs MFFU Funded-only vs Topstep/Tradeify exempt, and US/EU DST mismatch advisory (`$0` open).
  - `GET /api/cloud/presets` — Canonical server-maintained Topstep / Apex / MFFU / FTMO (1-Step & 2-Step) / Tradeify presets (`schemaVersion: 2026.11.v3`, `$0` open).
  - `POST /api/cloud/monte-carlo` — Public up to 25,000-run evaluation portfolio stress simulator (`$0` open).
  - `GET /api/cloud/brief` — Live Hyperliquid `/info` funding/OI + Polymarket Gamma API odds + DST/Gold rollover advisory (`$0` open).
  - `POST /api/cloud/portfolio-guard` — Cross-account Tradeify/FTMO anti-hedge & `ES+NQ` correlation guard (`$0` open).
  - `POST /api/cloud/relay/alert` — Public `dryRun: true` Telegram/Discord alert formatter; live outbound HTTP dispatches (`dryRun: false`) require Commercial Bearer auth (or Solo traders deploy [`../deploy/cloudflare-byo/`](../deploy/cloudflare-byo/README.md) onto their own `$0` Cloudflare account).
- **Non-Custodial Base USDC (`0x2105`) Commercial Checkout (`Founder Early-Bird 99 USDC` Team 2–99 seats / `499 USDC` Enterprise 100+ seats):** Supports Base EOA (`EIP-191`) and Smart Contract Wallets (`ERC-1271` / `EIP-6492`) with atomic `TxClaimLockDO` Durable Object SQLite replay locking + `GLOBAL_CLAIMED_TX_KV`.

## Quickstart

```bash
pnpm install --ignore-scripts
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
```
