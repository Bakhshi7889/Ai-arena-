export class PosterError extends Error {
  constructor(message, { status = 500, code = 'internal_error', details } = {}) {
    super(message);
    this.name = 'PosterError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message, details) =>
  new PosterError(message, { status: 400, code: 'bad_request', details });
export const unauthorized = (message = 'Invalid or missing API key') =>
  new PosterError(message, { status: 401, code: 'unauthorized' });
export const forbidden = (message = 'Not allowed') =>
  new PosterError(message, { status: 403, code: 'forbidden' });
export const notFound = (message = 'Not found') =>
  new PosterError(message, { status: 404, code: 'not_found' });
export const conflict = (message) => new PosterError(message, { status: 409, code: 'conflict' });
export const payloadTooLarge = (message) =>
  new PosterError(message, { status: 413, code: 'payload_too_large' });

/** Raised by adapters; becomes a per-target failure without killing the job. */
export class AdapterError extends Error {
  constructor(message, { code = 'adapter_error', retryable = true, status, details } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.details = details;
  }
}
