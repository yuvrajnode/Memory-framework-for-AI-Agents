/** Base class for every error the framework raises deliberately. */
export class MnemosError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: string, status = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): { error: string; code: string; message: string; details?: unknown } {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** A caller supplied something the framework cannot accept. */
export class ValidationError extends MnemosError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400, details);
  }
}

/** A referenced record does not exist in the target namespace. */
export class NotFoundError extends MnemosError {
  constructor(what: string, id: string) {
    super(`${what} "${id}" was not found`, 'NOT_FOUND', 404, { id });
  }
}

/** A backing store or provider failed in a way the caller may retry. */
export class StoreError extends MnemosError {
  constructor(message: string, details?: unknown) {
    super(message, 'STORE_ERROR', 503, details);
  }
}

/** An embedding provider rejected or failed a request. */
export class EmbeddingError extends MnemosError {
  constructor(message: string, details?: unknown) {
    super(message, 'EMBEDDING_ERROR', 502, details);
  }
}

export function isMnemosError(value: unknown): value is MnemosError {
  return value instanceof MnemosError;
}
