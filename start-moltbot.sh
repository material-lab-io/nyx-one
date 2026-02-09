#!/bin/bash
# Startup script for Moltbot in Cloudflare Sandbox
# This script:
# 1. Sources secrets from R2 mount (workaround for env var passing)
# 2. Restores config from R2 backup if available
# 3. Configures moltbot from environment variables
# 4. Starts a background sync to backup config to R2
# 5. Starts the gateway

set -e

# Check if clawdbot gateway is already running - bail early if so
# Note: CLI is still named "clawdbot" until upstream renames it
if pgrep -f "clawdbot gateway" > /dev/null 2>&1; then
    echo "Moltbot gateway is already running, exiting."
    exit 0
fi

# Paths (clawdbot paths are used internally - upstream hasn't renamed yet)
CONFIG_DIR="/root/.clawdbot"
CONFIG_FILE="$CONFIG_DIR/clawdbot.json"
TEMPLATE_DIR="/root/.clawdbot-templates"
TEMPLATE_FILE="$TEMPLATE_DIR/moltbot.json.template"
BACKUP_DIR="/data/moltbot"

# ============================================================
# SOURCE SECRETS FROM R2 MOUNT
# ============================================================
# Workaround: Cloudflare Sandbox doesn't pass env vars to container.
# The Worker writes secrets to R2, and we source them here.
SECRETS_FILE="$BACKUP_DIR/secrets.env"
if [ -f "$SECRETS_FILE" ]; then
    echo "Sourcing secrets from R2 mount..."
    . "$SECRETS_FILE"
    echo "Loaded secrets from R2"
else
    echo "No secrets file found at $SECRETS_FILE"
fi

echo "Config directory: $CONFIG_DIR"
echo "Backup directory: $BACKUP_DIR"

# Create config directory
mkdir -p "$CONFIG_DIR"

# ============================================================
# RESTORE FROM R2 BACKUP
# ============================================================
# Check if R2 backup exists by looking for clawdbot.json
# The BACKUP_DIR may exist but be empty if R2 was just mounted
# Note: backup structure is $BACKUP_DIR/clawdbot/ and $BACKUP_DIR/skills/

# Helper function to check if R2 backup is newer than local
should_restore_from_r2() {
    local R2_SYNC_FILE="$BACKUP_DIR/.last-sync"
    local LOCAL_SYNC_FILE="$CONFIG_DIR/.last-sync"
    
    # If no R2 sync timestamp, don't restore
    if [ ! -f "$R2_SYNC_FILE" ]; then
        echo "No R2 sync timestamp found, skipping restore"
        return 1
    fi
    
    # If no local sync timestamp, restore from R2
    if [ ! -f "$LOCAL_SYNC_FILE" ]; then
        echo "No local sync timestamp, will restore from R2"
        return 0
    fi
    
    # Compare timestamps
    R2_TIME=$(cat "$R2_SYNC_FILE" 2>/dev/null)
    LOCAL_TIME=$(cat "$LOCAL_SYNC_FILE" 2>/dev/null)
    
    echo "R2 last sync: $R2_TIME"
    echo "Local last sync: $LOCAL_TIME"
    
    # Convert to epoch seconds for comparison
    R2_EPOCH=$(date -d "$R2_TIME" +%s 2>/dev/null || echo "0")
    LOCAL_EPOCH=$(date -d "$LOCAL_TIME" +%s 2>/dev/null || echo "0")
    
    if [ "$R2_EPOCH" -gt "$LOCAL_EPOCH" ]; then
        echo "R2 backup is newer, will restore"
        return 0
    else
        echo "Local data is newer or same, skipping restore"
        return 1
    fi
}

if [ -f "$BACKUP_DIR/clawdbot/clawdbot.json" ]; then
    if should_restore_from_r2; then
        echo "Restoring from R2 backup at $BACKUP_DIR/clawdbot..."
        cp -a "$BACKUP_DIR/clawdbot/." "$CONFIG_DIR/"
        # Copy the sync timestamp to local so we know what version we have
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        echo "Restored config from R2 backup"
    fi
elif [ -f "$BACKUP_DIR/clawdbot.json" ]; then
    # Legacy backup format (flat structure)
    if should_restore_from_r2; then
        echo "Restoring from legacy R2 backup at $BACKUP_DIR..."
        cp -a "$BACKUP_DIR/." "$CONFIG_DIR/"
        cp -f "$BACKUP_DIR/.last-sync" "$CONFIG_DIR/.last-sync" 2>/dev/null || true
        echo "Restored config from legacy R2 backup"
    fi
elif [ -d "$BACKUP_DIR" ]; then
    echo "R2 mounted at $BACKUP_DIR but no backup data found yet"
else
    echo "R2 not mounted, starting fresh"
fi

# Restore skills from R2 backup if available (only if R2 is newer)
SKILLS_DIR="/root/clawd/skills"
if [ -d "$BACKUP_DIR/skills" ] && [ "$(ls -A $BACKUP_DIR/skills 2>/dev/null)" ]; then
    if should_restore_from_r2; then
        echo "Restoring skills from $BACKUP_DIR/skills..."
        mkdir -p "$SKILLS_DIR"
        cp -a "$BACKUP_DIR/skills/." "$SKILLS_DIR/"
        echo "Restored skills from R2 backup"
    fi
fi

# If config file still doesn't exist, create from template
if [ ! -f "$CONFIG_FILE" ]; then
    echo "No existing config found, initializing from template..."
    if [ -f "$TEMPLATE_FILE" ]; then
        cp "$TEMPLATE_FILE" "$CONFIG_FILE"
    else
        # Create minimal config if template doesn't exist
        cat > "$CONFIG_FILE" << 'EOFCONFIG'
{
  "agents": {
    "defaults": {
      "workspace": "/root/clawd"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local"
  }
}
EOFCONFIG
    fi
else
    echo "Using existing config"
fi

# ============================================================
# EXTRACT WHATSAPP CREDENTIALS FROM SECRET
# ============================================================
# Baileys stores credentials in creds.json (~2-5KB)
# We store this base64-encoded in WHATSAPP_CREDS_JSON secret
if [ -n "$WHATSAPP_CREDS_JSON" ]; then
    WHATSAPP_CREDS_DIR="/root/.clawdbot/credentials/whatsapp/default"
    echo "Extracting WhatsApp credentials to $WHATSAPP_CREDS_DIR..."
    mkdir -p "$WHATSAPP_CREDS_DIR"
    echo "$WHATSAPP_CREDS_JSON" | base64 -d > "$WHATSAPP_CREDS_DIR/creds.json"
    echo "WhatsApp credentials extracted"
fi

# ============================================================
# UPDATE CONFIG FROM ENVIRONMENT VARIABLES
# ============================================================
node << EOFNODE
const fs = require('fs');

const configPath = '/root/.clawdbot/clawdbot.json';
console.log('Updating config at:', configPath);
let config = {};

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    console.log('Starting with empty config');
}

// Ensure nested objects exist
config.agents = config.agents || {};
config.agents.defaults = config.agents.defaults || {};
config.agents.defaults.model = config.agents.defaults.model || {};
config.gateway = config.gateway || {};
config.channels = config.channels || {};

// Clean up any broken anthropic provider config from previous runs
// (older versions didn't include required 'name' field)
if (config.models?.providers?.anthropic?.models) {
    const hasInvalidModels = config.models.providers.anthropic.models.some(m => !m.name);
    if (hasInvalidModels) {
        console.log('Removing broken anthropic provider config (missing model names)');
        delete config.models.providers.anthropic;
    }
}



// Gateway configuration
config.gateway.port = 18789;
config.gateway.mode = 'local';
config.gateway.trustedProxies = ['0.0.0.0/0'];

// Set gateway token if provided
if (process.env.CLAWDBOT_GATEWAY_TOKEN) {
    config.gateway.auth = config.gateway.auth || {};
    config.gateway.auth.token = process.env.CLAWDBOT_GATEWAY_TOKEN;
}

// Allow insecure auth on the gateway's internal listener.
// The Worker proxy handles the secure HTTPS context for external clients,
// so the internal HTTP link between Worker and container is safe.
config.gateway.controlUi = config.gateway.controlUi || {};
config.gateway.controlUi.allowInsecureAuth = true;

// Telegram configuration
if (process.env.TELEGRAM_BOT_TOKEN) {
    config.channels.telegram = config.channels.telegram || {};
    config.channels.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.channels.telegram.enabled = true;
    const telegramDmPolicy = process.env.TELEGRAM_DM_POLICY || 'pairing';
    config.channels.telegram.dmPolicy = telegramDmPolicy;
    if (process.env.TELEGRAM_DM_ALLOW_FROM) {
        // Explicit allowlist: "123,456,789" → ['123', '456', '789']
        config.channels.telegram.allowFrom = process.env.TELEGRAM_DM_ALLOW_FROM.split(',');
    } else if (telegramDmPolicy === 'open') {
        // "open" policy requires allowFrom: ["*"]
        config.channels.telegram.allowFrom = ['*'];
    }
}

// Discord configuration
// Note: Discord uses nested dm.policy, not flat dmPolicy like Telegram
// See: https://github.com/moltbot/moltbot/blob/v2026.1.24-1/src/config/zod-schema.providers-core.ts#L147-L155
if (process.env.DISCORD_BOT_TOKEN) {
    config.channels.discord = config.channels.discord || {};
    config.channels.discord.token = process.env.DISCORD_BOT_TOKEN;
    config.channels.discord.enabled = true;

    // DM policy - allow DMs from anyone
    const discordDmPolicy = process.env.DISCORD_DM_POLICY || 'open';
    config.channels.discord.dm = config.channels.discord.dm || {};
    config.channels.discord.dm.policy = discordDmPolicy;
    if (discordDmPolicy === 'open') {
        config.channels.discord.dm.allowFrom = ['*'];
    }

    // Guild/server policy - 'open' allows bot to respond in any server channel
    // Must be set explicitly or doctor will default to 'allowlist'
    config.channels.discord.groupPolicy = process.env.DISCORD_GROUP_POLICY || 'open';

    // Allow bot to respond without being mentioned in guild channels
    // Must be set per-guild; use "*" wildcard for all guilds
    config.channels.discord.guilds = config.channels.discord.guilds || {};
    config.channels.discord.guilds['*'] = config.channels.discord.guilds['*'] || {};
    config.channels.discord.guilds['*'].requireMention = false;
}

// Slack configuration
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
    config.channels.slack = config.channels.slack || {};
    config.channels.slack.botToken = process.env.SLACK_BOT_TOKEN;
    config.channels.slack.appToken = process.env.SLACK_APP_TOKEN;
    config.channels.slack.enabled = true;
}

// WhatsApp configuration (Baileys)
// Note: Don't set 'enabled' directly - clawdbot doctor handles that.
// We just configure dmPolicy and allowFrom, then doctor --fix enables it.
if (process.env.WHATSAPP_ENABLED === 'true') {
    console.log('Configuring WhatsApp channel...');
    config.channels.whatsapp = config.channels.whatsapp || {};

    // DM policy: 'allowlist', 'pairing', or 'open'
    const whatsappDmPolicy = process.env.WHATSAPP_DM_POLICY || 'allowlist';
    config.channels.whatsapp.dmPolicy = whatsappDmPolicy;

    if (process.env.WHATSAPP_ALLOW_FROM) {
        // Explicit allowlist: "+1234567890,+0987654321" → ['+1234567890', '+0987654321']
        config.channels.whatsapp.allowFrom = process.env.WHATSAPP_ALLOW_FROM.split(',').map(s => s.trim());
        console.log('WhatsApp allowlist:', config.channels.whatsapp.allowFrom);
    } else if (whatsappDmPolicy === 'open') {
        config.channels.whatsapp.allowFrom = ['*'];
    }

    // Group policy: 'open', 'allowlist', or 'deny'
    const whatsappGroupPolicy = process.env.WHATSAPP_GROUP_POLICY || 'open';
    config.channels.whatsapp.groupPolicy = whatsappGroupPolicy;
    console.log('WhatsApp groupPolicy:', whatsappGroupPolicy);

    // Group-specific settings (JSON-encoded)
    if (process.env.WHATSAPP_GROUPS) {
        try {
            config.channels.whatsapp.groups = JSON.parse(process.env.WHATSAPP_GROUPS);
            console.log('WhatsApp groups config loaded');
        } catch (e) {
            console.log('Warning: Could not parse WHATSAPP_GROUPS:', e.message);
        }
    }
}

// ============================================================
// SWIGGY MCP SERVER CONFIGURATION
// ============================================================
// Configure mcporter with Swiggy HTTP+OAuth MCP servers.
// Phone-based access control: only phones matching SWIGGY_ALLOW_PHONES
// (default: phones ending in 0848) can use swiggy/instamart skills.
{
    const mcporterConfigDir = '/root/.mcporter';
    const mcporterConfigPath = mcporterConfigDir + '/mcporter.json';
    const fs2 = require('fs');

    let mcpConfig = {};
    try {
        mcpConfig = JSON.parse(fs2.readFileSync(mcporterConfigPath, 'utf8'));
    } catch (e) {
        // Start fresh
    }

    mcpConfig.mcpServers = mcpConfig.mcpServers || {};
    mcpConfig.mcpServers['swiggy-food'] = {
        type: 'http',
        url: 'https://mcp.swiggy.com/food',
        auth: 'oauth',
        oauthRedirectUrl: 'http://127.0.0.1:38305/callback'
    };
    mcpConfig.mcpServers['swiggy-instamart'] = {
        type: 'http',
        url: 'https://mcp.swiggy.com/im',
        auth: 'oauth',
        oauthRedirectUrl: 'http://127.0.0.1:38305/callback'
    };
    mcpConfig.imports = mcpConfig.imports || [];

    fs2.mkdirSync(mcporterConfigDir, { recursive: true });
    fs2.writeFileSync(mcporterConfigPath, JSON.stringify(mcpConfig, null, 2));
    console.log('Swiggy MCP servers configured in mcporter');
}

// Write SWIGGY_ALLOW_PHONES to a runtime file the agent can check.
// Default: phones ending in 0848. Format: comma-separated suffixes or full numbers.
{
    const allowPhones = process.env.SWIGGY_ALLOW_PHONES || '*0848';
    const runtimeDir = '/root/clawd';
    const fs3 = require('fs');
    fs3.mkdirSync(runtimeDir, { recursive: true });
    fs3.writeFileSync(runtimeDir + '/.swiggy-allow-phones', allowPhones);
    console.log('Swiggy phone ACL:', allowPhones);
}

// Base URL override (e.g., for Cloudflare AI Gateway)
// Usage: Set AI_GATEWAY_BASE_URL or ANTHROPIC_BASE_URL to your endpoint like:
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai
const baseUrl = (process.env.AI_GATEWAY_BASE_URL || process.env.ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
const isOpenAI = baseUrl.endsWith('/openai');

if (isOpenAI) {
    // Create custom openai provider config with baseUrl override
    // Omit apiKey so moltbot falls back to OPENAI_API_KEY env var
    console.log('Configuring OpenAI provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.openai = {
        baseUrl: baseUrl,
        api: 'openai-responses',
        models: [
            { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 200000 },
            { id: 'gpt-5', name: 'GPT-5', contextWindow: 200000 },
            { id: 'gpt-4.5-preview', name: 'GPT-4.5 Preview', contextWindow: 128000 },
        ]
    };
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['openai/gpt-5.2'] = { alias: 'GPT-5.2' };
    config.agents.defaults.models['openai/gpt-5'] = { alias: 'GPT-5' };
    config.agents.defaults.models['openai/gpt-4.5-preview'] = { alias: 'GPT-4.5' };
    config.agents.defaults.model.primary = 'openai/gpt-5.2';
} else if (baseUrl) {
    console.log('Configuring Anthropic provider with base URL:', baseUrl);
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    const providerConfig = {
        baseUrl: baseUrl,
        api: 'anthropic-messages',
        models: [
            { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', contextWindow: 200000 },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', contextWindow: 200000 },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
        ]
    };
    // Include API key in provider config if set (required when using custom baseUrl)
    if (process.env.ANTHROPIC_API_KEY) {
        providerConfig.apiKey = process.env.ANTHROPIC_API_KEY;
    }
    config.models.providers.anthropic = providerConfig;
    // Add models to the allowlist so they appear in /models
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['anthropic/claude-opus-4-5-20251101'] = { alias: 'Opus 4.5' };
    config.agents.defaults.models['anthropic/claude-sonnet-4-5-20250929'] = { alias: 'Sonnet 4.5' };
    config.agents.defaults.models['anthropic/claude-haiku-4-5-20251001'] = { alias: 'Haiku 4.5' };
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5-20251101';
} else {
    // Default to Anthropic without custom base URL (uses built-in pi-ai catalog)
    config.agents.defaults.model.primary = 'anthropic/claude-opus-4-5';
}

// Groq provider configuration
if (process.env.GROQ_API_KEY) {
    console.log('Configuring Groq provider...');
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers.groq = {
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        api: 'openai-completions',
        models: [
            { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 },
            { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', reasoning: false, input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 },
            { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 32768 },
            { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill 70B', reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 16384 },
            { id: 'qwen-qwq-32b', name: 'Qwen QWQ 32B', reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: 16384 },
        ]
    };
    // Add Groq models to the allowlist
    config.agents.defaults.models = config.agents.defaults.models || {};
    config.agents.defaults.models['groq/llama-3.3-70b-versatile'] = { alias: 'Llama 3.3 70B' };
    config.agents.defaults.models['groq/meta-llama/llama-4-maverick-17b-128e-instruct'] = { alias: 'Llama 4 Maverick' };
    config.agents.defaults.models['groq/meta-llama/llama-4-scout-17b-16e-instruct'] = { alias: 'Llama 4 Scout' };
    config.agents.defaults.models['groq/deepseek-r1-distill-llama-70b'] = { alias: 'DeepSeek R1' };
    config.agents.defaults.models['groq/qwen-qwq-32b'] = { alias: 'Qwen QWQ 32B' };

    // Set Groq as primary model if no AI Gateway/Anthropic base URL is configured
    // Use Llama 4 Maverick for better tool/function calling support
    if (!baseUrl) {
        config.agents.defaults.model.primary = 'groq/meta-llama/llama-4-maverick-17b-128e-instruct';
        console.log('Groq set as primary model provider (Llama 4 Maverick)');
    }
}

// Write updated config
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('Configuration updated successfully');
console.log('Config summary:', JSON.stringify({
    models: { providers: Object.keys(config.models?.providers || {}) },
    agents: { defaults: { model: config.agents?.defaults?.model } },
    channels: Object.fromEntries(
        Object.entries(config.channels || {}).map(([k, v]) => [k, { enabled: v.enabled }])
    ),
    gateway: { ...config.gateway, auth: config.gateway?.auth ? { token: '***' } : undefined },
}, null, 2));
EOFNODE

# Auto-fix detected issues (e.g., enable Discord channel for first time)
echo "Running doctor --fix to apply pending changes..."
clawdbot doctor --fix 2>&1 || true

# Force groupPolicy=open after doctor (doctor defaults to 'allowlist')
# This allows the bot to respond in any Discord server without an allowlist
node << 'EOFFIX'
const fs = require('fs');
const configPath = '/root/.clawdbot/clawdbot.json';
try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = false;

    if (config.channels?.discord) {
        const oldPolicy = config.channels.discord.groupPolicy;
        config.channels.discord.groupPolicy = 'open';
        if (oldPolicy !== 'open') {
            console.log('Forced Discord groupPolicy:', oldPolicy, '-> open');
            changed = true;
        }
    }

    // Also force WhatsApp groupPolicy after doctor
    if (config.channels?.whatsapp) {
        const oldWaPolicy = config.channels.whatsapp.groupPolicy;
        const targetWaPolicy = process.env.WHATSAPP_GROUP_POLICY || 'open';
        config.channels.whatsapp.groupPolicy = targetWaPolicy;
        if (oldWaPolicy !== targetWaPolicy) {
            console.log('Forced WhatsApp groupPolicy:', oldWaPolicy, '->', targetWaPolicy);
            changed = true;
        }

        // Re-apply group-specific settings that doctor may have cleared
        if (process.env.WHATSAPP_GROUPS) {
            try {
                config.channels.whatsapp.groups = JSON.parse(process.env.WHATSAPP_GROUPS);
                changed = true;
            } catch (e) {
                // Already warned during initial config
            }
        }
    }

    if (changed) {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
} catch (e) {
    console.log('Note: Could not update groupPolicy:', e.message);
}
EOFFIX

# ============================================================
# START GATEWAY
# ============================================================
# Note: R2 backup sync is handled by the Worker's cron trigger
echo "Starting Moltbot Gateway..."
echo "Gateway will be available on port 18789"

# Clean up stale lock files
rm -f /tmp/clawdbot-gateway.lock 2>/dev/null || true
rm -f "$CONFIG_DIR/gateway.lock" 2>/dev/null || true

BIND_MODE="lan"
echo "Dev mode: ${CLAWDBOT_DEV_MODE:-false}, Bind mode: $BIND_MODE"

if [ -n "$CLAWDBOT_GATEWAY_TOKEN" ]; then
    echo "Starting gateway with token auth..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE" --token "$CLAWDBOT_GATEWAY_TOKEN"
else
    echo "Starting gateway with device pairing (no token)..."
    exec clawdbot gateway --port 18789 --verbose --allow-unconfigured --bind "$BIND_MODE"
fi
