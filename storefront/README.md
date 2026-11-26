# evalshield-copilot Hosted Cloud Pro API & Storefront

Cloudflare Workers Worker + Durable Object (`TxClaimLockDO`) + KV service powering:

- **Hosted Cloud Pro API (`Authorization: Bearer EVALSHIELD-PRO-v1...`):**
  - `GET /api/cloud/blackout-calendar` — Public summary preview or authenticated FOMC/CPI/NFP/PCE CME macro blackout calendar & size multipliers.
  - `GET /api/cloud/presets` — Canonical server-maintained Topstep / Apex / MFFU / Tradeify rule presets (`schemaVersion: 2026.11.v2`).
  - `POST /api/cloud/monte-carlo` — Pro-authenticated server-side up to 25,000-run evaluation portfolio stress simulator.
  - `POST /api/cloud/relay/alert` — Pro-authenticated, SSRF-guarded Discord/Telegram Tilt & Daily-Loss-Limit webhook relay + dry-run formatter.
- **Interactive Client-Side Prop Shield & 10k Monte Carlo Simulator** (`$0` MIT demo).
- **Non-Custodial Base USDC (`0x2105`) Checkout (`29 USDC` Solo / `99 USDC` Team):** Supports Base EOA (`EIP-191`) and Smart Contract Wallets (`ERC-1271` / `EIP-6492`) with atomic `TxClaimLockDO` Durable Object SQLite replay locking + `GLOBAL_CLAIMED_TX_KV`.

## Quickstart

```bash
pnpm install --ignore-scripts
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
```
