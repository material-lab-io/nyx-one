import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage, writeSecretsToR2 } from './r2';
import { waitForProcess } from './utils';

/**
 * Kill all clawdbot/gateway processes in the container.
 * This is more aggressive than just killing the parent start-moltbot.sh process
 * because child node processes can become orphaned and hold the port.
 */
export async function killAllGatewayProcesses(sandbox: Sandbox): Promise<void> {
  console.log('[Gateway] Killing all processes...');

  // First, kill all running processes via Sandbox API
  try {
    const processes = await sandbox.listProcesses();
    const runningProcesses = processes.filter(p => p.status === 'running' || p.status === 'starting');
    console.log(`[Gateway] Found ${runningProcesses.length} running processes to kill`);

    for (const proc of runningProcesses) {
      try {
        console.log(`[Gateway] Killing process ${proc.id}: ${proc.command.substring(0, 50)}...`);
        await proc.kill();
      } catch (killErr) {
        console.log(`[Gateway] Failed to kill ${proc.id}:`, killErr);
      }
    }
  } catch (e) {
    console.log('[Gateway] Failed to list/kill processes:', e);
  }

  // Also use pkill as a fallback (catches orphaned system processes)
  try {
    await sandbox.startProcess('pkill -9 -f clawdbot || pkill -9 -f start-moltbot || true');
    await new Promise(r => setTimeout(r, 1000));
  } catch (e) {
    console.log('[Gateway] pkill failed (may be expected):', e);
  }

  // Clean up lock files that can prevent startup
  try {
    await sandbox.startProcess(
      'rm -f /tmp/clawdbot-gateway.lock /root/.clawdbot/gateway.lock /tmp/moltbot-env.sh 2>/dev/null || true'
    );
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    // Ignore cleanup errors
  }

  // Wait a moment for ports to be released
  await new Promise(r => setTimeout(r, 2000));
  console.log('[Gateway] Cleanup complete');
}

/**
 * Find an existing Moltbot gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();

    // Sort by process ID (timestamp-based) to get the most recent first
    const sortedProcesses = [...processes].sort((a, b) => {
      // Extract timestamp from proc_TIMESTAMP_xxx format
      const getTimestamp = (id: string) => {
        const match = id.match(/proc_(\d+)_/);
        return match ? parseInt(match[1], 10) : 0;
      };
      return getTimestamp(b.id) - getTimestamp(a.id);
    });

    for (const proc of sortedProcesses) {
      // Only match the gateway process that's started correctly
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isCorrectGatewayProcess =
        proc.command === '/usr/local/bin/start-moltbot.sh' ||
        proc.command.includes('. /tmp/moltbot-env.sh') || // New format with dot-sourcing
        proc.command.includes('clawdbot gateway');
      const isBrokenWorkaround = proc.command.includes('source /tmp/moltbot-env.sh'); // Old failed format
      const isCliCommand =
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isCorrectGatewayProcess && !isBrokenWorkaround && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          console.log('[Gateway] Found existing gateway process:', proc.id, proc.command.substring(0, 50));
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Mount R2 storage for persistent data (non-blocking if not configured)
  // R2 is used as a backup - the startup script will restore from it on boot
  await mountR2Storage(sandbox, env);

  // Write secrets to R2 so the container can source them
  // (Workaround: Cloudflare Sandbox doesn't pass env vars to container processes)
  await writeSecretsToR2(env);

  // Check if Moltbot is already running or starting
  const existingProcess = await findExistingMoltbotProcess(sandbox);
  if (existingProcess) {
    console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);

    // First do a quick check (5 seconds) to see if the port is already listening
    // This catches zombie processes that are marked "running" but actually dead
    try {
      console.log('Quick port check on', MOLTBOT_PORT);
      await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: 5000 });
      console.log('Moltbot gateway is reachable');
      return existingProcess;
    } catch (quickCheckError) {
      console.log('Quick check failed, trying full timeout...');

      // If the process was started recently (within last 2 minutes), wait longer
      const processTimestamp = parseInt(existingProcess.id.match(/proc_(\d+)_/)?.[1] || '0', 10);
      const ageMs = Date.now() - processTimestamp;
      const isRecent = ageMs < 120000; // 2 minutes

      if (isRecent) {
        try {
          console.log('Process is recent, waiting full timeout:', STARTUP_TIMEOUT_MS);
          await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
          console.log('Moltbot gateway is reachable after full wait');
          return existingProcess;
        } catch (fullTimeoutError) {
          console.log('Process not reachable after full timeout');
        }
      } else {
        console.log('Process is old (', ageMs, 'ms), treating as zombie');
      }

      // Kill the zombie process
      console.log('Killing zombie process...');
      try {
        await existingProcess.kill();
      } catch (killError) {
        console.log('Failed to kill process:', killError);
      }
    }
  }

  // Start a new Moltbot gateway
  console.log('Starting new Moltbot gateway...');
  const envVars = buildEnvVars(env);
  const command = '/usr/local/bin/start-moltbot.sh';

  console.log('Starting process with command:', command);
  console.log('Environment vars count:', Object.keys(envVars).length);

  // Write env vars to a file that will be sourced by the startup script
  // The Cloudflare Sandbox env option doesn't work reliably, so we use a file
  if (Object.keys(envVars).length > 0) {
    try {
      // Create env file content with proper escaping
      const envFileLines = Object.entries(envVars).map(([key, value]) => {
        // Escape single quotes in value
        const escapedValue = value.replace(/'/g, "'\"'\"'");
        return `export ${key}='${escapedValue}'`;
      });
      const envFileContent = envFileLines.join('\n');

      // Write the env file (use printf to handle special characters)
      const writeCmd = `printf '%s' '${envFileContent.replace(/'/g, "'\\''")}' > /tmp/moltbot-env.sh`;
      const writeProc = await sandbox.startProcess(writeCmd);

      // Wait for the write to complete
      await waitForProcess(writeProc, 5000);
      console.log('Wrote env vars to /tmp/moltbot-env.sh');
    } catch (writeErr) {
      console.error('Failed to write env file:', writeErr);
      // Continue anyway, the gateway might work with default config
    }
  }

  let process: Process;
  try {
    // Source the env file before running the start script
    const fullCommand = Object.keys(envVars).length > 0
      ? `bash -c '. /tmp/moltbot-env.sh; ${command}'`
      : command;

    process = await sandbox.startProcess(fullCommand);
    console.log('Process started with id:', process.id, 'status:', process.status);
  } catch (startErr) {
    console.error('Failed to start process:', startErr);
    throw startErr;
  }

  // Wait for the gateway to be ready
  try {
    console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT);
    await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
    console.log('[Gateway] Moltbot gateway is ready!');

    const logs = await process.getLogs();
    if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
    if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
  } catch (e) {
    console.error('[Gateway] waitForPort failed:', e);
    try {
      const logs = await process.getLogs();
      console.error('[Gateway] startup failed. Stderr:', logs.stderr);
      console.error('[Gateway] startup failed. Stdout:', logs.stdout);
      throw new Error(`Moltbot gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`);
    } catch (logErr) {
      console.error('[Gateway] Failed to get logs:', logErr);
      throw e;
    }
  }

  // Verify gateway is actually responding
  console.log('[Gateway] Verifying gateway health...');
  try {
    const healthResp = await sandbox.containerFetch(
      new Request(`http://localhost:${MOLTBOT_PORT}/health`),
      MOLTBOT_PORT
    );
    console.log('[Gateway] Health check status:', healthResp.status);
  } catch (healthErr) {
    console.log('[Gateway] Health check failed (non-fatal):', healthErr);
  }

  return process;
}
