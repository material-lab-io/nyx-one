import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createAccessMiddleware } from '../auth';
import { ensureMoltbotGateway, findExistingMoltbotProcess, killAllGatewayProcesses, mountR2Storage, syncToR2, waitForProcess } from '../gateway';
import { R2_MOUNT_PATH } from '../config';

// CLI commands can take 10-15 seconds to complete due to WebSocket connection overhead
const CLI_TIMEOUT_MS = 20000;

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

// Mount admin API routes under /admin
api.route('/admin', adminApi);

export { api };
