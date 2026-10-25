/**
 * Base class for errors we raise on purpose. `code` is a stable identifier for
 * logs and API responses; `status` is the HTTP status to answer with; `expose`
 * marks messages that are safe to show to visitors.
 */
export class AppError extends Error {
  constructor(message, { code = 'INTERNAL', status = 500, expose = false, cause, details } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.expose = expose;
    if (details) this.details = details;
  }
}

export class ConfigError extends AppError {
  constructor(message) {
    super(message, { code: 'CONFIG_INVALID' });
  }
}

/** A failed call to the TIDAL API or token endpoint. Never carries tokens. */
export class TidalError extends AppError {
  constructor(message, { status, tidalCode, subStatus, requestId, url, retryable = false, cause } = {}) {
    super(message, { code: 'TIDAL_ERROR', status: 502, cause });
    this.upstreamStatus = status;
    this.tidalCode = tidalCode;
    this.subStatus = subStatus;
    this.requestId = requestId;
    this.url = url;
    this.retryable = retryable;
  }
}

/** TIDAL refused our credentials or their scope. Retrying will not help. */
export class TidalAuthError extends TidalError {
  constructor(message, options) {
    super(message, { ...options, retryable: false });
    this.code = 'TIDAL_AUTH';
  }
}

export class CatalogueUnavailableError extends AppError {
  constructor(cause) {
    super('Playlists are temporarily unavailable. Please try again shortly.', {
      code: 'CATALOGUE_UNAVAILABLE',
      status: 503,
      expose: true,
      cause,
    });
  }
}

export class BadRequestError extends AppError {
  constructor(message) {
    super(message, { code: 'BAD_REQUEST', status: 400, expose: true });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(message, { code: 'NOT_FOUND', status: 404, expose: true });
  }
}

/** Plain, loggable summary of any thrown value, including its cause chain. */
export function serialiseError(error, depth = 0) {
  if (!(error instanceof Error)) return { message: String(error) };
  const out = { name: error.name, message: error.message, stack: error.stack };
  for (const key of ['code', 'status', 'upstreamStatus', 'tidalCode', 'subStatus', 'requestId', 'url', 'details']) {
    if (error[key] !== undefined) out[key] = error[key];
  }
  if (error.cause && depth < 3) out.cause = serialiseError(error.cause, depth + 1);
  return out;
}
