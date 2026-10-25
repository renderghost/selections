import { createRequire } from 'node:module';
import pino from 'pino';
import { serialiseError } from './errors.js';

const hasPrettyPrinter = () => {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
};

/**
 * Structured JSON logs in production (searchable in the host's log viewer),
 * readable coloured logs locally. Secrets are redacted wherever they appear.
 */
export function createLogger({ level = 'info', pretty = false } = {}) {
  return pino({
    level,
    base: undefined,
    serializers: { err: serialiseError, error: serialiseError },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.access_token',
        '*.refresh_token',
        '*.client_secret',
      ],
      censor: '[redacted]',
    },
    ...(pretty && hasPrettyPrinter()
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  });
}
