# Deploy Your Own `$0` 24/7 Solo Sentinel (`deploy/cloudflare-byo/`)

Under the **ApexHive Dual License (`Solo 0 USDC Forever`)**, single traders can deploy this lightweight sentinel onto **their own free Cloudflare Workers account** in under 5 minutes. Even when your trading PC is turned off, your private Cloudflare Cron (`*/15 * * * *`) checks Hyperliquid Funding/OI, Polymarket macro odds, US/EU DST shifts, and pre-filtered TradingView webhooks before messaging your own Telegram or Discord.

**Server cost to ApexHive: `$0.00`. Data leaves your account: `ZERO`.**

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
