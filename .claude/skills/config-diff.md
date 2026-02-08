# config-diff

Compare OpenClaw configurations between agents or backups.

## Usage

```
/config-diff nyx perhitbot              # Compare two agents
/config-diff nyx 2026-02-07             # Compare agent with backup
/config-diff 2026-02-07 2026-02-08      # Compare two backups
```

## Agent/Backup Paths

| Reference | Config Path |
|-----------|-------------|
| nyx | ~/.openclaw/openclaw.json |
| perhitbot | /data/perhitbot/.openclaw/openclaw.json |
| YYYY-MM-DD/nyx | ~/.openclaw/backups/YYYY-MM-DD/nyx/openclaw.json |
| YYYY-MM-DD/perhitbot | ~/.openclaw/backups/YYYY-MM-DD/perhitbot/openclaw.json |

## Comparison Procedure

### 1. Resolve paths
```bash
# Determine full paths based on input
# Agent names map to live configs
# Date patterns map to backup dirs
```

### 2. Extract comparable sections
```bash
# Get key sections for comparison
jq '{
  agents: .agents.defaults,
  channels: .channels,
  tools: .tools,
  plugins: .plugins
}' <config1>

jq '{
  agents: .agents.defaults,
  channels: .channels,
  tools: .tools,
  plugins: .plugins
}' <config2>
```

### 3. Run diff
```bash
# Side-by-side JSON diff
diff <(jq -S . <config1>) <(jq -S . <config2>)

# Or use jq to show differences
jq -n --slurpfile a <config1> --slurpfile b <config2> '
  ($a[0] | keys) + ($b[0] | keys) | unique | .[] as $k |
  select($a[0][$k] != $b[0][$k]) |
  {key: $k, left: $a[0][$k], right: $b[0][$k]}
'
```

### 4. Highlight key differences

Focus on these areas:
- `agents.defaults.memorySearch.enabled`
- `channels.discord.enabled`
- `channels.whatsapp.dmPolicy`
- `channels.whatsapp.allowFrom`
- `tools.browser.enabled`
- `tools.media.audio.enabled`
- `plugins.entries` (which extensions enabled)

## Output Format

```
Config Diff: Nyx vs PerhitBot
=============================

Feature Comparison:
┌─────────────────┬──────────┬─────────────┐
│ Feature         │ Nyx      │ PerhitBot   │
├─────────────────┼──────────┼─────────────┤
│ memorySearch    │ off      │ off         │
│ browser         │ on       │ on          │
│ discord         │ on       │ off         │ ← different
│ whatsapp        │ allowlist│ allowlist   │
│ audio           │ on       │ on          │
└─────────────────┴──────────┴─────────────┘

Channel Differences:
- Discord: Nyx has enabled, PerhitBot does not
- WhatsApp allowFrom: Different phone lists

Plugin Differences:
- perhit-db: Only on PerhitBot

Full diff available at: /tmp/config-diff-output.json
```

## Common Comparisons

### Compare feature flags
```bash
echo "=== Nyx ===" && jq '.agents.defaults' ~/.openclaw/openclaw.json
echo "=== PerhitBot ===" && jq '.agents.defaults' /data/perhitbot/.openclaw/openclaw.json
```

### Compare channels
```bash
echo "=== Nyx ===" && jq '.channels' ~/.openclaw/openclaw.json
echo "=== PerhitBot ===" && jq '.channels' /data/perhitbot/.openclaw/openclaw.json
```

### Compare plugins/extensions
```bash
echo "=== Nyx ===" && jq '.plugins.entries | keys' ~/.openclaw/openclaw.json
echo "=== PerhitBot ===" && jq '.plugins.entries | keys' /data/perhitbot/.openclaw/openclaw.json
```

## Use Cases

1. **Before promoting config changes**: Diff staging vs production
2. **Debugging issues**: Compare working vs broken agent
3. **Auditing**: Check what changed since last backup
4. **Cloning**: See what to copy when setting up new agent
