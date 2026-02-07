import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';
import { buildEnvVars } from './env';

/** Path to secrets file in R2 mount */
export const R2_SECRETS_PATH = `${R2_MOUNT_PATH}/secrets.env`;

/**
 * Check if R2 is already mounted by looking at the mount table
 */
async function isR2Mounted(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(`mount | grep "s3fs on ${R2_MOUNT_PATH}"`);
    // Wait for the command to complete
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    // If stdout has content, the mount exists
    const mounted = !!(logs.stdout && logs.stdout.includes('s3fs'));
    console.log('isR2Mounted check:', mounted, 'stdout:', logs.stdout?.slice(0, 100));
    return mounted;
  } catch (err) {
    console.log('isR2Mounted error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log('R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)');
    return false;
  }

  // Check if already mounted first - this avoids errors and is faster
  if (await isR2Mounted(sandbox)) {
    console.log('R2 bucket already mounted at', R2_MOUNT_PATH);
    return true;
  }

  const bucketName = getR2BucketName(env);
  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      // Pass credentials explicitly since we use R2_* naming instead of AWS_*
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully - moltbot data will persist across sessions');
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.log('R2 mount error:', errorMessage);
    
    // Check again if it's mounted - the error might be misleading
    if (await isR2Mounted(sandbox)) {
      console.log('R2 bucket is mounted despite error');
      return true;
    }
    
    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}

/**
 * Write secrets to R2 bucket as a sourceable env file.
 *
 * This is a workaround for Cloudflare Sandbox not properly passing
 * environment variables to container processes. Instead, we write
 * the secrets to R2, and the container sources them from the R2 mount.
 *
 * @param env - Worker environment bindings
 * @returns true if secrets were written successfully
 */
export async function writeSecretsToR2(env: MoltbotEnv): Promise<boolean> {
  if (!env.R2_STORAGE) {
    console.log('[R2] No R2_STORAGE binding, cannot write secrets');
    return false;
  }

  const envVars = buildEnvVars(env);
  if (Object.keys(envVars).length === 0) {
    console.log('[R2] No secrets to write');
    return false;
  }

  // Build shell-sourceable content with proper escaping
  const lines = Object.entries(envVars).map(([key, value]) => {
    // Escape single quotes in value by replacing ' with '\''
    const escapedValue = value.replace(/'/g, "'\\''");
    return `export ${key}='${escapedValue}'`;
  });
  const content = lines.join('\n') + '\n';

  try {
    // Write to R2 bucket at secrets.env path
    await env.R2_STORAGE.put('secrets.env', content, {
      httpMetadata: { contentType: 'text/plain' },
    });
    console.log(`[R2] Wrote ${Object.keys(envVars).length} secrets to R2 (secrets.env)`);
    return true;
  } catch (err) {
    console.error('[R2] Failed to write secrets:', err);
    return false;
  }
}
