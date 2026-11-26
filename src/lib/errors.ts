export type ErrorKind =
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'rate_limit'
  | 'validation'
  | 'conflict'
  | 'server'
  | 'network'
  | 'config';

/** Error raised by every API client. Messages never contain credentials. */
export class ApiError extends Error {
  constructor(
    readonly service: 'GitHub' | 'Hugging Face' | 'Authentication relay' | 'Panel',
    readonly kind: ErrorKind,
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isNotFound(): boolean {
    return this.kind === 'not_found';
  }
}

export function kindForStatus(status: number, rateLimited = false): ErrorKind {
  if (status === 401) return 'auth';
  if (status === 403 && rateLimited) return 'rate_limit';
  if (status === 429) return 'rate_limit';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 422 || status === 400) return 'validation';
  return 'server';
}

/** Human readable description of any thrown value. */
export function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const prefix = `${error.service}`;
    switch (error.kind) {
      case 'auth':
        return `${prefix} rejected the credentials. Sign in again or update the token.`;
      case 'rate_limit':
        return `${prefix} rate limit reached. Requests resume automatically.`;
      case 'network':
        return `${prefix} could not be reached. Check your connection.`;
      default:
        return `${prefix}: ${error.message}`;
    }
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'not_found';
}
