/**
 * Business failures.
 *
 * An `ApiError` is a failure the user can act on; the route serializes it as a
 * normal JSON envelope instead of a 500, so the dialog can show the message
 * verbatim.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  /**
   * @param code - stable machine-readable failure code.
   * @param message - human-readable explanation.
   * @param details - optional structured data (paths, per-group reasons).
   */
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}
