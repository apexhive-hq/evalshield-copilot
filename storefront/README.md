# evalshield-copilot Open Risk Sandbox & Commercial License Issuer

Cloudflare Workers + Durable Object (`TxClaimLockDO`) + KV service providing analytical risk endpoints and Base USDC license issuance for `evalshield-copilot`:

- **Open Risk Analytical Sandbox:**
  - `GET /api/cloud/blackout-calendar` — Verified 2026–2027 FOMC/CPI/NFP schedules with exact US Eastern DST conversion, FTMO strict `±2m` SL/TP ban vs MFFU Funded-only vs Topstep/Tradeify exempt, and US/EU DST mismatch advisory.
  - `GET /api/cloud/presets` — Canonical server-maintained Topstep / Apex / MFFU / FTMO (1-Step & 2-Step) / Tradeify presets (`schemaVersion: 2026.11.v3`).
  - `POST /api/cloud/monte-carlo` — Public up to 25,000-run evaluation portfolio stress simulator.
  - `GET /api/cloud/brief` — Live Hyperliquid `/info` funding/OI + Polymarket Gamma API odds + DST/Gold rollover advisory.
  - `POST /api/cloud/portfolio-guard` — Cross-account Tradeify/FTMO anti-hedge & `ES+NQ` correlation guard.
  - `POST /api/cloud/relay/alert` — Public `dryRun: true` Telegram/Discord alert formatter; live outbound HTTP dispatches (`dryRun: false`) require Team or Enterprise Bearer auth (or self-host [`../deploy/cloudflare-byo/`](../deploy/cloudflare-byo/README.md) on your own Cloudflare Workers account).
- **Non-Custodial Base USDC (`0x2105`) Commercial Checkout (`99 USDC` Team 2–99 seats / `499 USDC` Enterprise 100+ seats):** Supports Base EOA (`EIP-191`) and Smart Contract Wallets (`ERC-1271` / `EIP-6492`) with atomic `TxClaimLockDO` Durable Object SQLite replay locking + `GLOBAL_CLAIMED_TX_KV`.

## Quickstart

```bash
pnpm install --ignore-scripts
pnpm exec playwright install chromium
pnpm run typecheck
pnpm test
```
