import pino from 'pino';

/** Structured JSON logger. Secrets are redacted by key name. */
export function createLogger(level = process.env.LOG_LEVEL || 'info'): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        'token',
        '*.token',
        '*_token',
        'secret',
        '*.secret',
        'privateKey',
        'private_key',
        '*.privateKey',
        'password',
        'authorization',
        '*.authorization',
        'GITHUB_APP_PRIVATE_KEY',
        'OPENCODE_GO_KEY',
        'x-github-token',
        'installationToken',
      ],
      censor: '[REDACTED]',
    },
    base: { app: 'swear-review', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = pino.Logger;
