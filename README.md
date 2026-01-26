# Clawdbot in Cloudflare Sandbox

Run [Clawdbot](https://clawd.bot/) personal AI assistant in a Cloudflare Sandbox container.

## What is this?

This project runs Clawdbot's Gateway inside a Cloudflare Sandbox container. The Gateway serves a web-based Control UI where you can chat with your AI assistant and manage settings.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- An Anthropic API key
- Cloudflare account with Workers and Containers access

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure secrets

Set your Anthropic API key:

```bash
wrangler secret put ANTHROPIC_API_KEY
```

### 3. Deploy

```bash
npm run deploy
```

The first deploy will take a few minutes as it builds the Docker image with Node.js 22 and Clawdbot.

### 4. Access your Clawdbot

Open the deployed Worker URL in your browser. The Gateway serves a Control UI where you can interact with your assistant.

## Configuration

### Required Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key for Claude models |

### Optional Secrets

| Secret | Description |
|--------|-------------|
| `CLAWDBOT_GATEWAY_TOKEN` | Token to protect gateway access |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack app token (required with bot token) |

### Setting Secrets

```bash
wrangler secret put <SECRET_NAME>
# Enter the value when prompted
```

## Channel Setup

Channels are optional - the web UI works without any channel configuration.

### Telegram

1. Create a bot via [@BotFather](https://t.me/botfather)
2. Set the secret: `wrangler secret put TELEGRAM_BOT_TOKEN`
3. Redeploy: `npm run deploy`

### Discord

1. Create an application at [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a bot and copy the token
3. Set the secret: `wrangler secret put DISCORD_BOT_TOKEN`
4. Invite the bot to your server
5. Redeploy: `npm run deploy`

### Slack

1. Create a Slack app at [api.slack.com](https://api.slack.com/apps)
2. Enable Socket Mode and get tokens
3. Set secrets:
   ```bash
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put SLACK_APP_TOKEN
   ```
4. Redeploy: `npm run deploy`

## Architecture

```
Browser
   │
   ▼
┌─────────────────────────────────────┐
│     Cloudflare Worker               │
│  - Starts Clawdbot in sandbox       │
│  - Proxies requests to Gateway      │
│  - Passes secrets as env vars       │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│     Cloudflare Sandbox Container    │
│  ┌───────────────────────────────┐  │
│  │     Clawdbot Gateway          │  │
│  │  - Control UI on port 18789   │  │
│  │  - Agent runtime              │  │
│  │  - Channel connectors         │  │
│  └───────────────────────────────┘  │
└─────────────────────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker that manages sandbox and proxies requests |
| `Dockerfile` | Container image with Node 22 + Clawdbot |
| `start-clawdbot.sh` | Startup script that configures and launches Gateway |
| `clawdbot.json.template` | Default Clawdbot configuration |
| `wrangler.jsonc` | Cloudflare Worker + Container config |

## Customization

### Change the Model

Edit `clawdbot.json.template`:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-20250514"
      }
    }
  }
}
```

Available models:
- `anthropic/claude-opus-4-5` - Most capable
- `anthropic/claude-sonnet-4-20250514` - Good balance (default)
- `anthropic/claude-haiku-4-5` - Fastest/cheapest

After changing the template, bump the cache bust comment in `Dockerfile` and redeploy to rebuild the image.

## Troubleshooting

### Gateway fails to start

1. Check secrets are set: `wrangler secret list`
2. Check Worker logs: `wrangler tail`

### Config changes not taking effect

The Docker image caches the config template. To force a rebuild:

1. Edit the `# Build cache bust:` comment in `Dockerfile`
2. Redeploy: `npm run deploy`

### Cold start timeout

First request after deployment may take 1-2 minutes as the container starts and Clawdbot initializes. Subsequent requests are faster.

## Links

- [Clawdbot](https://clawd.bot/)
- [Clawdbot Docs](https://docs.clawd.bot)
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk)

## License

MIT
