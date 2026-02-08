import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, killAllGatewayProcesses, mountR2Storage, syncToR2, waitForProcess } from '../gateway';
import { R2_MOUNT_PATH } from '../config';
import { transcribeAudio, DEFAULT_STT_MODEL } from '../stt';
import { synthesizeSpeech, getAvailableVoices, getAvailableModels, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../tts';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

// Input validation helpers to prevent shell injection
function isValidIdentifier(value: string): boolean {
  // Only allow alphanumeric, dash, underscore, colon (for session keys)
  return /^[a-zA-Z0-9_:-]+$/.test(value) && value.length <= 256;
}

function isValidSessionKey(key: string): boolean {
  // Session keys: alphanumeric with some allowed separators, no path traversal
  return /^[a-zA-Z0-9_:.-]+$/.test(key) && !key.includes('..') && key.length <= 256;
}

// Known valid providers for model testing
const VALID_PROVIDERS = ['anthropic', 'openai', 'groq', 'ollama', 'azure'] as const;

/**
 * API routes
 * - /api/admin/* - Protected admin API routes (Cloudflare Access required)
 * 
 * Note: /api/status is now handled by publicRoutes (no auth required)
 */
const api = new Hono<AppEnv>();

/**
 * Admin API routes - all protected by Cloudflare Access
 */
const adminApi = new Hono<AppEnv>();

// Middleware: Verify Cloudflare Access JWT for all admin routes
adminApi.use('*', createAccessMiddleware({ type: 'json' }));

// GET /api/admin/devices - List pending and paired devices
adminApi.get('/devices', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to list devices (CLI is still named clawdbot until upstream renames)
    // Must specify --url to connect to the gateway running in the same container
    const proc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output (may have other log lines)
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        return c.json(data);
      }

      // If no JSON found, return raw output for debugging
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
      });
    } catch {
      return c.json({
        pending: [],
        paired: [],
        raw: stdout,
        stderr,
        parseError: 'Failed to parse CLI output',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/:requestId/approve - Approve a pending device
adminApi.post('/devices/:requestId/approve', async (c) => {
  const sandbox = c.get('sandbox');
  const requestId = c.req.param('requestId');

  if (!requestId) {
    return c.json({ error: 'requestId is required' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run moltbot CLI to approve the device (CLI is still named clawdbot)
    const proc = await sandbox.startProcess(`clawdbot devices approve ${requestId} --url ws://localhost:18789`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Check for success indicators (case-insensitive, CLI outputs "Approved ...")
    const success = stdout.toLowerCase().includes('approved') || proc.exitCode === 0;

    return c.json({
      success,
      requestId,
      message: success ? 'Device approved' : 'Approval may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/devices/approve-all - Approve all pending devices
adminApi.post('/devices/approve-all', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // First, get the list of pending devices (CLI is still named clawdbot)
    const listProc = await sandbox.startProcess('clawdbot devices list --json --url ws://localhost:18789');
    await waitForProcess(listProc, CLI_TIMEOUT_MS);

    const listLogs = await listProc.getLogs();
    const stdout = listLogs.stdout || '';

    // Parse pending devices
    let pending: Array<{ requestId: string }> = [];
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        pending = data.pending || [];
      }
    } catch {
      return c.json({ error: 'Failed to parse device list', raw: stdout }, 500);
    }

    if (pending.length === 0) {
      return c.json({ approved: [], message: 'No pending devices to approve' });
    }

    // Approve each pending device
    const results: Array<{ requestId: string; success: boolean; error?: string }> = [];

    for (const device of pending) {
      try {
        const approveProc = await sandbox.startProcess(`clawdbot devices approve ${device.requestId} --url ws://localhost:18789`);
        await waitForProcess(approveProc, CLI_TIMEOUT_MS);

        const approveLogs = await approveProc.getLogs();
        const success = approveLogs.stdout?.toLowerCase().includes('approved') || approveProc.exitCode === 0;

        results.push({ requestId: device.requestId, success });
      } catch (err) {
        results.push({
          requestId: device.requestId,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const approvedCount = results.filter(r => r.success).length;
    return c.json({
      approved: results.filter(r => r.success).map(r => r.requestId),
      failed: results.filter(r => !r.success),
      message: `Approved ${approvedCount} of ${pending.length} device(s)`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/storage - Get R2 storage status and last sync time
adminApi.get('/storage', async (c) => {
  const sandbox = c.get('sandbox');
  const hasCredentials = !!(
    c.env.R2_ACCESS_KEY_ID && 
    c.env.R2_SECRET_ACCESS_KEY && 
    c.env.CF_ACCOUNT_ID
  );

  // Check which credentials are missing
  const missing: string[] = [];
  if (!c.env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!c.env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!c.env.CF_ACCOUNT_ID) missing.push('CF_ACCOUNT_ID');

  let lastSync: string | null = null;

  // If R2 is configured, check for last sync timestamp
  if (hasCredentials) {
    try {
      // Mount R2 if not already mounted
      await mountR2Storage(sandbox, c.env);
      
      // Check for sync marker file
      const proc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync 2>/dev/null || echo ""`);
      await waitForProcess(proc, 5000);
      const logs = await proc.getLogs();
      const timestamp = logs.stdout?.trim();
      if (timestamp && timestamp !== '') {
        lastSync = timestamp;
      }
    } catch {
      // Ignore errors checking sync status
    }
  }

  return c.json({
    configured: hasCredentials,
    missing: missing.length > 0 ? missing : undefined,
    lastSync,
    message: hasCredentials 
      ? 'R2 storage is configured. Your data will persist across container restarts.'
      : 'R2 storage is not configured. Paired devices and conversations will be lost when the container restarts.',
  });
});

// POST /api/admin/storage/sync - Trigger a manual sync to R2
adminApi.post('/storage/sync', async (c) => {
  const sandbox = c.get('sandbox');
  
  const result = await syncToR2(sandbox, c.env);
  
  if (result.success) {
    return c.json({
      success: true,
      message: 'Sync completed successfully',
      lastSync: result.lastSync,
    });
  } else {
    const status = result.error?.includes('not configured') ? 400 : 500;
    return c.json({
      success: false,
      error: result.error,
      details: result.details,
    }, status);
  }
});

// GET /api/admin/debug/env - Check what env vars the worker has access to (DEBUG)
adminApi.get('/debug/env', async (c) => {
  return c.json({
    hasWhatsappEnabled: !!c.env.WHATSAPP_ENABLED,
    whatsappEnabled: c.env.WHATSAPP_ENABLED,
    hasWhatsappAllowFrom: !!c.env.WHATSAPP_ALLOW_FROM,
    whatsappAllowFrom: c.env.WHATSAPP_ALLOW_FROM,
    hasWhatsappCredsJson: !!c.env.WHATSAPP_CREDS_JSON,
    whatsappCredsJsonLen: c.env.WHATSAPP_CREDS_JSON?.length || 0,
    hasGroqApiKey: !!c.env.GROQ_API_KEY,
    hasDiscordToken: !!c.env.DISCORD_BOT_TOKEN,
    hasGatewayToken: !!c.env.MOLTBOT_GATEWAY_TOKEN,
  });
});

// GET /api/admin/debug/processes - List all running processes
adminApi.get('/debug/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    return c.json({
      count: processes.length,
      processes: processes.map(p => ({
        id: p.id,
        command: p.command.substring(0, 100),
        status: p.status,
      })),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/debug/killall - Kill ALL processes in the sandbox
adminApi.post('/debug/killall', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Kill absolutely everything
    const proc = await sandbox.startProcess('pkill -9 -e . || killall -9 -r . || true');
    await new Promise(r => setTimeout(r, 2000));
    return c.json({ success: true, message: 'Killed all processes' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/debug/container-env - Check env vars inside the container
adminApi.get('/debug/container-env', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Check both the env file and source it to show what the gateway would see
    const proc = await sandbox.startProcess(`
      echo "=== ENV FILE EXISTS ===" &&
      ls -la /tmp/moltbot-env.sh 2>/dev/null || echo "ENV FILE NOT FOUND" &&
      echo "" &&
      echo "=== ENV FILE CONTENT ===" &&
      head -5 /tmp/moltbot-env.sh 2>/dev/null || echo "CANNOT READ FILE" &&
      echo "" &&
      echo "=== SOURCED ENV VARS ===" &&
      (. /tmp/moltbot-env.sh 2>/dev/null && env | grep -E "WHATSAPP|GROQ|DISCORD|CLAWDBOT" | head -10) || echo "SOURCE FAILED"
    `);
    await new Promise(r => setTimeout(r, 5000));
    const logs = await proc.getLogs();
    return c.json({
      stdout: logs.stdout,
      stderr: logs.stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/debug/gateway-logs - Get logs from the most recent gateway process
adminApi.get('/debug/gateway-logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    // Find the most recent start-moltbot.sh process (handles both direct and bash -c versions)
    const gatewayProcesses = processes
      .filter(p => p.command.includes('start-moltbot.sh'))
      .sort((a, b) => {
        const getTs = (id: string) => parseInt(id.match(/proc_(\d+)_/)?.[1] || '0', 10);
        return getTs(b.id) - getTs(a.id);
      });

    if (gatewayProcesses.length === 0) {
      return c.json({ error: 'No gateway process found' });
    }

    const proc = gatewayProcesses[0];
    const logs = await proc.getLogs();
    return c.json({
      processId: proc.id,
      status: proc.status,
      command: proc.command.substring(0, 100),
      stdout: logs.stdout?.substring(0, 5000) || '',
      stderr: logs.stderr?.substring(0, 5000) || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/debug/test-process - Test if we can start a simple process
adminApi.get('/debug/test-process', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    console.log('Starting test process...');
    const proc = await sandbox.startProcess('echo "Hello from sandbox" && date');
    console.log('Process started, waiting...');
    await new Promise(r => setTimeout(r, 2000));
    const logs = await proc.getLogs();
    return c.json({
      success: true,
      processId: proc.id,
      status: proc.status,
      stdout: logs.stdout,
      stderr: logs.stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, stack: error instanceof Error ? error.stack : undefined }, 500);
  }
});

// GET /api/admin/whatsapp/link - Generate WhatsApp QR code for device linking
// Returns: { qrText: string, qrDataUrl: string, expiresIn: number }
// Note: QR code expires in ~20 seconds, scan quickly!
adminApi.get('/whatsapp/link', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run clawdbot web link --json to get QR code
    // This generates a new QR code for device linking
    const proc = await sandbox.startProcess('clawdbot web link --json --url ws://localhost:18789');

    // Wait longer for QR generation (can take a few seconds)
    await waitForProcess(proc, 30000);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    // Try to parse JSON output
    try {
      // Find JSON in output
      const jsonMatch = stdout.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const data = JSON.parse(jsonMatch[0]);
        // data should contain { qrText, qrDataUrl, expiresIn }
        return c.json(data);
      }

      // Check for errors
      if (stderr.includes('already linked') || stdout.includes('already linked')) {
        return c.json({
          error: 'WhatsApp is already linked',
          message: 'Device is already connected. Use /api/admin/whatsapp/logout to unlink first.',
        }, 400);
      }

      // If no JSON found, return raw output
      return c.json({
        error: 'Failed to generate QR code',
        raw: stdout,
        stderr,
      }, 500);
    } catch {
      return c.json({
        error: 'Failed to parse QR response',
        raw: stdout,
        stderr,
      }, 500);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/whatsapp/status - Check WhatsApp connection status
adminApi.get('/whatsapp/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run doctor to get real channel status
    const doctorProc = await sandbox.startProcess('clawdbot doctor');
    await waitForProcess(doctorProc, 15000);
    const doctorLogs = await doctorProc.getLogs();
    const doctorStdout = doctorLogs.stdout || '';

    // Parse WhatsApp status from doctor output
    // Format: "WhatsApp: linked (auth age 1m)" or "WhatsApp: not linked"
    const whatsappMatch = doctorStdout.match(/WhatsApp:\s*(.+)/);
    const whatsappStatus = whatsappMatch ? whatsappMatch[1].trim() : 'unknown';
    const isLinked = whatsappStatus.includes('linked');

    // Parse web channel phone number
    // Format: "Web Channel: +919187520828 (jid ...)"
    const webChannelMatch = doctorStdout.match(/Web Channel:\s*(\+\d+)/);
    const phoneNumber = webChannelMatch ? webChannelMatch[1] : null;

    // Check WhatsApp config
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const configStdout = configLogs.stdout || '';

    // Check if credentials file exists
    const credsProc = await sandbox.startProcess('ls -la /root/.clawdbot/credentials/whatsapp/default/ 2>&1 || echo "NO_CREDS_DIR"');
    await waitForProcess(credsProc, 5000);
    const credsLogs = await credsProc.getLogs();
    const credsStdout = credsLogs.stdout || '';

    try {
      const config = JSON.parse(configStdout);
      const whatsappConfig = config.channels?.whatsapp || {};

      return c.json({
        connected: isLinked,
        status: whatsappStatus,
        phoneNumber,
        dmPolicy: whatsappConfig.dmPolicy || 'not set',
        allowFrom: whatsappConfig.allowFrom || [],
        credentialsDir: credsStdout.includes('NO_CREDS_DIR') ? 'not found' : 'exists',
        credentialsFiles: credsStdout,
      });
    } catch {
      return c.json({
        connected: isLinked,
        status: whatsappStatus,
        phoneNumber,
        error: 'Could not parse config',
        credentialsDir: credsStdout,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/whatsapp/enable - Enable WhatsApp channel via CLI
adminApi.post('/whatsapp/enable', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Try to enable WhatsApp channel via doctor --fix (runs offline against config)
    const doctorProc = await sandbox.startProcess('clawdbot doctor --fix');
    await waitForProcess(doctorProc, 30000);

    const doctorLogs = await doctorProc.getLogs();
    const doctorStdout = doctorLogs.stdout || '';
    const doctorStderr = doctorLogs.stderr || '';

    // Check if WhatsApp was enabled
    const enabled = doctorStdout.includes('channels.whatsapp.enabled') ||
                   doctorStdout.includes('WhatsApp enabled');

    return c.json({
      success: enabled,
      message: enabled ? 'WhatsApp channel enabled' : 'Could not enable WhatsApp - check logs',
      stdout: doctorStdout,
      stderr: doctorStderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/whatsapp/logout - Unlink WhatsApp device
adminApi.post('/whatsapp/logout', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Run clawdbot web logout to unlink
    const proc = await sandbox.startProcess('clawdbot web logout --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = stdout.toLowerCase().includes('logged out') ||
                   stdout.toLowerCase().includes('unlinked') ||
                   proc.exitCode === 0;

    return c.json({
      success,
      message: success ? 'WhatsApp device unlinked' : 'Logout may have failed',
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/cli - Run clawdbot CLI command
adminApi.post('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const body = await c.req.json<{ command: string }>();
  const command = body.command;

  if (!command) {
    return c.json({ error: 'command is required' }, 400);
  }

  // Safety check - only allow clawdbot commands
  if (!command.startsWith('clawdbot ')) {
    return c.json({ error: 'Only clawdbot commands are allowed' }, 400);
  }

  try {
    // Ensure moltbot is running first
    await ensureMoltbotGateway(sandbox, c.env);

    // Commands that don't need --url flag
    // Most commands work against the local gateway without needing --url
    const offlineCommands = ['config get', 'config set', 'config unset', '--help', '--version', 'doctor', 'message', 'channels'];
    const needsUrl = !offlineCommands.some(cmd => command.includes(cmd));
    const fullCommand = needsUrl ? `${command} --url ws://localhost:18789` : command;

    const proc = await sandbox.startProcess(fullCommand);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    return c.json({
      exitCode: proc.exitCode,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/gateway/restart - Kill the current gateway and start a new one
adminApi.post('/gateway/restart', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    // Find existing process for reporting
    const existingProcess = await findExistingMoltbotProcess(sandbox);

    // Kill ALL gateway processes (including orphaned child processes)
    // This is more aggressive than just killing the parent process
    await killAllGatewayProcesses(sandbox);

    // Start a new gateway in the background
    const bootPromise = ensureMoltbotGateway(sandbox, c.env).catch((err) => {
      console.error('Gateway restart failed:', err);
    });
    c.executionCtx.waitUntil(bootPromise);

    return c.json({
      success: true,
      message: existingProcess
        ? 'Gateway process killed, new instance starting...'
        : 'No existing process found, starting new instance...',
      previousProcessId: existingProcess?.id,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// ============================================
// STT (Speech-to-Text) Endpoints
// ============================================

// POST /api/admin/stt/transcribe - Transcribe audio to text
// Accepts multipart/form-data with:
//   - file: audio file (mp3, wav, webm, etc.)
//   - language?: string (optional language hint)
//   - model?: string (default: whisper-large-v3-turbo)
adminApi.post('/stt/transcribe', async (c) => {
  const groqApiKey = c.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return c.json({ error: 'GROQ_API_KEY is not configured' }, 500);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('file');
    const language = formData.get('language') as string | null;
    const model = formData.get('model') as string | null;

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'file is required (multipart/form-data)' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const result = await transcribeAudio({
      buffer,
      fileName: file.name || 'audio',
      mime: file.type || undefined,
      apiKey: groqApiKey,
      model: model || DEFAULT_STT_MODEL,
      language: language || undefined,
    });

    return c.json({
      text: result.text,
      model: result.model,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/stt/models - Get available STT models
adminApi.get('/stt/models', async (c) => {
  return c.json({
    models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
    default: DEFAULT_STT_MODEL,
    provider: 'groq',
  });
});

// ============================================
// TTS (Text-to-Speech) Endpoints
// ============================================

// POST /api/admin/tts/synthesize - Synthesize speech from text
// Accepts JSON body:
//   - text: string (required)
//   - voice?: string (default: alloy)
//   - model?: string (default: gpt-4o-mini-tts)
//   - format?: mp3|opus (default: mp3)
// Returns: audio/mpeg or audio/opus binary
adminApi.post('/tts/synthesize', async (c) => {
  const openaiApiKey = c.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    return c.json({ error: 'OPENAI_API_KEY is not configured' }, 500);
  }

  try {
    const body = await c.req.json<{
      text: string;
      voice?: string;
      model?: string;
      format?: 'mp3' | 'opus';
    }>();

    if (!body.text?.trim()) {
      return c.json({ error: 'text is required' }, 400);
    }

    const format = body.format || 'mp3';
    const result = await synthesizeSpeech({
      text: body.text,
      apiKey: openaiApiKey,
      model: body.model || DEFAULT_TTS_MODEL,
      voice: body.voice || DEFAULT_TTS_VOICE,
      responseFormat: format,
    });

    const contentType = format === 'opus' ? 'audio/opus' : 'audio/mpeg';
    return new Response(result.audio, {
      headers: {
        'Content-Type': contentType,
        'X-TTS-Model': result.model,
        'X-TTS-Voice': result.voice,
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/tts/voices - Get available TTS voices and models
adminApi.get('/tts/voices', async (c) => {
  return c.json({
    voices: getAvailableVoices(),
    models: getAvailableModels(),
    defaults: {
      voice: DEFAULT_TTS_VOICE,
      model: DEFAULT_TTS_MODEL,
    },
    provider: 'openai',
  });
});

// ============================================
// Sessions API (Phase 1)
// ============================================

// GET /api/admin/sessions - List sessions with metadata
adminApi.get('/sessions', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const limit = c.req.query('limit') || '50';
    const activeMinutes = c.req.query('activeMinutes') || '60';

    // Use clawdbot sessions command
    const proc = await sandbox.startProcess(
      `clawdbot sessions --json --active ${activeMinutes} --url ws://localhost:18789`
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    // Try to parse JSON array from output
    const jsonMatch = stdout.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const sessions = JSON.parse(jsonMatch[0]);
      // Apply limit
      const limitNum = parseInt(limit, 10);
      return c.json({
        sessions: sessions.slice(0, limitNum),
        total: sessions.length,
      });
    }

    // Fallback: return raw output
    return c.json({
      sessions: [],
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/sessions/:sessionKey/history - Get message history for a session
adminApi.get('/sessions/:sessionKey/history', async (c) => {
  const sandbox = c.get('sandbox');
  const sessionKey = c.req.param('sessionKey');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '200', 10) || 200, 1), 1000);

  if (!sessionKey || !isValidSessionKey(sessionKey)) {
    return c.json({ error: 'Invalid sessionKey format' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Read session file directly (JSONL format)
    const sessionPath = `/root/.clawdbot/sessions/${sessionKey}.jsonl`;
    const proc = await sandbox.startProcess(`cat "${sessionPath}" 2>/dev/null || echo "SESSION_NOT_FOUND"`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    if (stdout.includes('SESSION_NOT_FOUND')) {
      return c.json({ error: 'Session not found', sessionKey }, 404);
    }

    // Parse JSONL - each line is a message
    const messages = stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Apply limit (get last N messages)
    const limitedMessages = messages.slice(-limit);

    return c.json({
      sessionKey,
      messages: limitedMessages,
      total: messages.length,
      limited: messages.length > limit,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/sessions/:sessionKey/preview - Get preview snippets of recent messages
adminApi.get('/sessions/:sessionKey/preview', async (c) => {
  const sandbox = c.get('sandbox');
  const sessionKey = c.req.param('sessionKey');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '5', 10) || 5, 1), 50);
  const maxChars = Math.min(Math.max(parseInt(c.req.query('maxChars') || '200', 10) || 200, 1), 1000);

  if (!sessionKey || !isValidSessionKey(sessionKey)) {
    return c.json({ error: 'Invalid sessionKey format' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Read session file directly
    const sessionPath = `/root/.clawdbot/sessions/${sessionKey}.jsonl`;
    const proc = await sandbox.startProcess(`tail -${limit * 2} "${sessionPath}" 2>/dev/null || echo "SESSION_NOT_FOUND"`);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    if (stdout.includes('SESSION_NOT_FOUND')) {
      return c.json({ error: 'Session not found', sessionKey }, 404);
    }

    // Parse JSONL and extract previews
    const messages = stdout
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-limit);

    const previews = messages.map((msg: Record<string, unknown>) => ({
      role: msg.role || 'unknown',
      preview: typeof msg.content === 'string'
        ? msg.content.substring(0, maxChars) + (msg.content.length > maxChars ? '...' : '')
        : '[non-text content]',
      timestamp: msg.timestamp || msg.createdAt || null,
    }));

    return c.json({
      sessionKey,
      previews,
      count: previews.length,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// ============================================
// Skills API (Phase 3)
// ============================================

// GET /api/admin/skills - List all skills with status
adminApi.get('/skills', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const eligible = c.req.query('eligible');
    const cmd = eligible === 'true'
      ? 'clawdbot skills list --json --eligible --url ws://localhost:18789'
      : 'clawdbot skills list --json --url ws://localhost:18789';

    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    // Try to parse JSON array or object
    const jsonMatch = stdout.match(/[\[\{][\s\S]*[\]\}]/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      return c.json(Array.isArray(data) ? { skills: data } : data);
    }

    return c.json({
      skills: [],
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/skills/:name - Get details about a specific skill
adminApi.get('/skills/:name', async (c) => {
  const sandbox = c.get('sandbox');
  const name = c.req.param('name');

  if (!name || !isValidIdentifier(name)) {
    return c.json({ error: 'Invalid skill name. Only alphanumeric, dash, and underscore allowed.' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const proc = await sandbox.startProcess(
      `clawdbot skills info ${name} --json --url ws://localhost:18789`
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return c.json(JSON.parse(jsonMatch[0]));
    }

    // Check for "not found" type errors
    if (stdout.includes('not found') || logs.stderr?.includes('not found')) {
      return c.json({ error: 'Skill not found', name }, 404);
    }

    return c.json({
      name,
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/skills/:name/install - Install a skill dependency
adminApi.post('/skills/:name/install', async (c) => {
  const sandbox = c.get('sandbox');
  const name = c.req.param('name');
  const body = await c.req.json<{ installId?: string }>().catch(() => ({} as { installId?: string }));

  if (!name || !isValidIdentifier(name)) {
    return c.json({ error: 'Invalid skill name. Only alphanumeric, dash, and underscore allowed.' }, 400);
  }

  // Validate installId if provided
  if (body.installId && !isValidIdentifier(body.installId)) {
    return c.json({ error: 'Invalid installId format' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // If installId provided, install that specific dependency
    const cmd = body.installId
      ? `clawdbot skills install ${name} ${body.installId} --url ws://localhost:18789`
      : `clawdbot skills install ${name} --url ws://localhost:18789`;

    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, 60000); // Allow longer for installs

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = proc.exitCode === 0 ||
                   stdout.toLowerCase().includes('installed') ||
                   stdout.toLowerCase().includes('success');

    return c.json({
      success,
      skill: name,
      installId: body.installId,
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/skills/:name/enable - Enable/disable a skill
adminApi.post('/skills/:name/enable', async (c) => {
  const sandbox = c.get('sandbox');
  const name = c.req.param('name');
  const body = await c.req.json<{ enabled?: boolean; apiKey?: string }>().catch(() => ({} as { enabled?: boolean; apiKey?: string }));

  if (!name || !isValidIdentifier(name)) {
    return c.json({ error: 'Invalid skill name. Only alphanumeric, dash, and underscore allowed.' }, 400);
  }

  // Validate apiKey format if provided (alphanumeric, dash, underscore only for safety)
  if (body.apiKey && !/^[a-zA-Z0-9_-]+$/.test(body.apiKey)) {
    return c.json({ error: 'Invalid API key format. Only alphanumeric, dash, and underscore allowed.' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Build command based on what's being set
    let cmd = `clawdbot skills config ${name}`;
    if (typeof body.enabled === 'boolean') {
      cmd += body.enabled ? ' --enable' : ' --disable';
    }
    if (body.apiKey) {
      cmd += ` --api-key "${body.apiKey}"`;
    }
    cmd += ' --url ws://localhost:18789';

    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = proc.exitCode === 0;

    return c.json({
      success,
      skill: name,
      enabled: body.enabled,
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// ============================================
// Memory/Embeddings API (Phase 2)
// ============================================

// GET /api/admin/memory/status - Get memory index status
adminApi.get('/memory/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const proc = await sandbox.startProcess('clawdbot memory status --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return c.json(JSON.parse(jsonMatch[0]));
    }

    return c.json({
      status: 'unknown',
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/memory/search - Search memory with embeddings
adminApi.post('/memory/search', async (c) => {
  const sandbox = c.get('sandbox');
  const body = await c.req.json<{
    query: string;
    maxResults?: number;
    minScore?: number;
  }>().catch(() => ({ query: '' } as { query: string; maxResults?: number; minScore?: number }));

  if (!body.query?.trim()) {
    return c.json({ error: 'query is required' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const maxResults = body.maxResults || 10;
    const minScore = body.minScore || 0.5;

    // Escape query for shell
    const escapedQuery = body.query.replace(/'/g, "'\\''");
    const proc = await sandbox.startProcess(
      `clawdbot memory search '${escapedQuery}' --json --max-results ${maxResults} --min-score ${minScore} --url ws://localhost:18789`
    );
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    // Try to parse array or object response
    const jsonMatch = stdout.match(/[\[\{][\s\S]*[\]\}]/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      return c.json(Array.isArray(data) ? { results: data } : data);
    }

    return c.json({
      results: [],
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/memory/sync - Trigger memory reindex
adminApi.post('/memory/sync', async (c) => {
  const sandbox = c.get('sandbox');
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const cmd = body.force
      ? 'clawdbot memory index --force --url ws://localhost:18789'
      : 'clawdbot memory index --url ws://localhost:18789';

    const proc = await sandbox.startProcess(cmd);
    await waitForProcess(proc, 60000); // Allow longer for indexing

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = proc.exitCode === 0 ||
                   stdout.toLowerCase().includes('indexed') ||
                   stdout.toLowerCase().includes('complete');

    return c.json({
      success,
      force: body.force || false,
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/memory/files - List indexed memory files
adminApi.get('/memory/files', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const proc = await sandbox.startProcess('clawdbot memory files --json --url ws://localhost:18789');
    await waitForProcess(proc, CLI_TIMEOUT_MS);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';

    const jsonMatch = stdout.match(/[\[\{][\s\S]*[\]\}]/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      return c.json(Array.isArray(data) ? { files: data } : data);
    }

    return c.json({
      files: [],
      raw: stdout,
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// ============================================
// Additional Channel Status APIs (Phase 4)
// ============================================

// GET /api/admin/telegram/status - Check Telegram bot status
adminApi.get('/telegram/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Check config for telegram settings
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const configStdout = configLogs.stdout || '';

    // Run doctor to get status
    const doctorProc = await sandbox.startProcess('clawdbot doctor');
    await waitForProcess(doctorProc, 15000);
    const doctorLogs = await doctorProc.getLogs();
    const doctorStdout = doctorLogs.stdout || '';

    // Parse Telegram status from doctor output
    const telegramMatch = doctorStdout.match(/Telegram:\s*(.+)/);
    const telegramStatus = telegramMatch ? telegramMatch[1].trim() : 'not configured';

    try {
      const config = JSON.parse(configStdout);
      const telegramConfig = config.channels?.telegram || {};

      return c.json({
        configured: !!telegramConfig.botToken || !!c.env.TELEGRAM_BOT_TOKEN,
        status: telegramStatus,
        enabled: telegramConfig.enabled !== false,
        hasToken: !!telegramConfig.botToken || !!c.env.TELEGRAM_BOT_TOKEN,
      });
    } catch {
      return c.json({
        configured: !!c.env.TELEGRAM_BOT_TOKEN,
        status: telegramStatus,
        error: 'Could not parse config',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/slack/status - Check Slack bot status
adminApi.get('/slack/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Check config for slack settings
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const configStdout = configLogs.stdout || '';

    // Run doctor to get status
    const doctorProc = await sandbox.startProcess('clawdbot doctor');
    await waitForProcess(doctorProc, 15000);
    const doctorLogs = await doctorProc.getLogs();
    const doctorStdout = doctorLogs.stdout || '';

    // Parse Slack status from doctor output
    const slackMatch = doctorStdout.match(/Slack:\s*(.+)/);
    const slackStatus = slackMatch ? slackMatch[1].trim() : 'not configured';

    try {
      const config = JSON.parse(configStdout);
      const slackConfig = config.channels?.slack || {};

      return c.json({
        configured: !!slackConfig.botToken || !!c.env.SLACK_BOT_TOKEN,
        status: slackStatus,
        enabled: slackConfig.enabled !== false,
        hasToken: !!slackConfig.botToken || !!c.env.SLACK_BOT_TOKEN,
        hasAppToken: !!slackConfig.appToken || !!c.env.SLACK_APP_TOKEN,
      });
    } catch {
      return c.json({
        configured: !!c.env.SLACK_BOT_TOKEN,
        status: slackStatus,
        error: 'Could not parse config',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /api/admin/discord/status - Check Discord bot status
adminApi.get('/discord/status', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Check config for discord settings
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const configStdout = configLogs.stdout || '';

    // Run doctor to get status
    const doctorProc = await sandbox.startProcess('clawdbot doctor');
    await waitForProcess(doctorProc, 15000);
    const doctorLogs = await doctorProc.getLogs();
    const doctorStdout = doctorLogs.stdout || '';

    // Parse Discord status from doctor output
    const discordMatch = doctorStdout.match(/Discord:\s*(.+)/);
    const discordStatus = discordMatch ? discordMatch[1].trim() : 'not configured';

    try {
      const config = JSON.parse(configStdout);
      const discordConfig = config.channels?.discord || {};

      return c.json({
        configured: !!discordConfig.token || !!c.env.DISCORD_BOT_TOKEN,
        status: discordStatus,
        enabled: discordConfig.enabled !== false,
        hasToken: !!discordConfig.token || !!c.env.DISCORD_BOT_TOKEN,
      });
    } catch {
      return c.json({
        configured: !!c.env.DISCORD_BOT_TOKEN,
        status: discordStatus,
        error: 'Could not parse config',
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// ============================================
// Models API (Phase 4b)
// ============================================

// GET /api/admin/models - List configured models/providers
adminApi.get('/models', async (c) => {
  const sandbox = c.get('sandbox');

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    // Read config to see model settings
    const configProc = await sandbox.startProcess('cat /root/.clawdbot/clawdbot.json');
    await waitForProcess(configProc, 5000);
    const configLogs = await configProc.getLogs();
    const configStdout = configLogs.stdout || '';

    try {
      const config = JSON.parse(configStdout);
      const llm = config.llm || {};

      return c.json({
        provider: llm.provider || 'anthropic',
        model: llm.model || 'claude-sonnet-4-5-20250929',
        configured: {
          anthropic: !!c.env.ANTHROPIC_API_KEY,
          openai: !!c.env.OPENAI_API_KEY,
          groq: !!c.env.GROQ_API_KEY,
        },
        settings: {
          maxTokens: llm.maxTokens,
          temperature: llm.temperature,
        },
      });
    } catch {
      return c.json({
        error: 'Could not parse config',
        raw: configStdout,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// POST /api/admin/models/test - Test model availability
adminApi.post('/models/test', async (c) => {
  const sandbox = c.get('sandbox');
  const body = await c.req.json<{ provider?: string; model?: string }>().catch(() => ({} as { provider?: string; model?: string }));

  // Validate provider
  const provider = body.provider || 'anthropic';
  if (!VALID_PROVIDERS.includes(provider as typeof VALID_PROVIDERS[number])) {
    return c.json({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` }, 400);
  }

  // Validate model name format
  const model = body.model || 'claude-sonnet-4-5-20250929';
  if (!isValidIdentifier(model)) {
    return c.json({ error: 'Invalid model name format' }, 400);
  }

  try {
    await ensureMoltbotGateway(sandbox, c.env);

    const proc = await sandbox.startProcess(
      `clawdbot model test --provider ${provider} --model ${model} --url ws://localhost:18789`
    );
    await waitForProcess(proc, 30000);

    const logs = await proc.getLogs();
    const stdout = logs.stdout || '';
    const stderr = logs.stderr || '';

    const success = proc.exitCode === 0 ||
                   stdout.toLowerCase().includes('success') ||
                   stdout.toLowerCase().includes('ok');

    return c.json({
      success,
      provider,
      model,
      stdout,
      stderr,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
