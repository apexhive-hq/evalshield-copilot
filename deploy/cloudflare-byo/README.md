# Self-Hosted Alert Sentinel (`deploy/cloudflare-byo/`)

Standalone Cloudflare Workers alert sentinel for `evalshield-copilot`. Runs on your own Cloudflare Workers account on a 15-minute Cron schedule (`*/15 * * * *`) to monitor Hyperliquid funding/OI, Polymarket macro odds, US/EU DST transitions, and pre-filtered TradingView webhooks, forwarding formatted risk alerts to your Telegram or Discord when your trading machine is off.

## 5-Minute Setup

```bash
cd deploy/cloudflare-byo
pnpm install --ignore-scripts

# Set your private Telegram Bot or Discord Webhook secret (never committed to git)
npx wrangler secret put ALERT_WEBHOOK_URL
# e.g. https://api.telegram.org/bot<YOUR_TOKEN>/sendMessage  OR  https://discord.com/api/webhooks/...

# Set your REQUIRED TradingView webhook secret (worker fails closed 503 SERVICE_UNCONFIGURED if unset):
npx wrangler secret put TRADINGVIEW_WEBHOOK_SECRET

# Optional for Telegram chat targeting:
npx wrangler secret put TELEGRAM_CHAT_ID

npx wrangler deploy
```

Configure `POLYMARKET_SLUGS`, `POLL_COINS`, and `BRIEF_UTC_HOUR` in `wrangler.toml`.

---

Included for Solo local use (Free) under the [ApexHive Dual Source-Available License](../../LICENSE). Your webhook secrets and alert payloads remain inside your own Cloudflare account.
