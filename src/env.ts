import { readFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';

export interface EnvConfig {
  port: number;
  githubAppId: number;
  githubAppPrivateKey: string;
  githubWebhookSecret: string;
  opencodeGoKey: string;
  configPath: string;
  databasePath: string;
  logLevel: string;
  ocrBinary: string | undefined;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads .env (if present) and validates required secrets. The private key may
 * be passed inline (PEM) or as a path.
 */
export function loadEnv(): EnvConfig {
  loadDotenv({ quiet: true });

  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY || process.env.GITHUB_APP_PRIVATE_KEY_PATH || '';
  let githubAppPrivateKey: string;
  if (privateKeyRaw.includes('-----BEGIN')) {
    githubAppPrivateKey = privateKeyRaw.replace(/\\n/g, '\n');
  } else if (privateKeyRaw !== '') {
    githubAppPrivateKey = readFileSync(privateKeyRaw, 'utf8');
  } else {
    throw new Error('Missing required environment variable: GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH)');
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    githubAppId: Number(required('GITHUB_APP_ID')),
    githubAppPrivateKey,
    githubWebhookSecret: required('GITHUB_WEBHOOK_SECRET'),
    opencodeGoKey: required('OPENCODE_GO_KEY'),
    configPath: process.env.CONFIG_PATH || '/data/config.yaml',
    databasePath: process.env.DATABASE_PATH || '/data/swear-review.db',
    logLevel: process.env.LOG_LEVEL || 'info',
    ocrBinary: process.env.OCR_BIN || undefined,
  };
}
