/**
 * aggkit API Error
 *
 * Thrown by `AggkitBridgeClient` for every non-2xx HTTP response and for
 * network/transport failures after retries are exhausted. Distinct from the
 * core `ApiError` (`../core/utils/apiError.ts`) — aggkit's error bodies are a
 * uniform bare `{"error": "<message>"}` shape (no `code`/`name`/`details`),
 * so this class carries `httpStatus` + `endpoint` + the raw `body` instead.
 */

export interface AggkitApiErrorArgs {
  message: string;
  httpStatus: number;
  endpoint: string;
  body?: string;
}

export class AggkitApiError extends Error {
  public override readonly name: string = 'AggkitApiError';
  /** HTTP status code: 400/404/500/503 for server errors. */
  public readonly httpStatus: number;
  /** The aggkit endpoint path that was called, e.g. "/bridges". */
  public readonly endpoint: string;
  /** Raw response body text (the `{"error": "..."}` payload), when available. */
  public readonly body?: string;

  constructor(args: AggkitApiErrorArgs) {
    super(args.message);

    this.httpStatus = args.httpStatus;
    this.endpoint = args.endpoint;
    if (args.body !== undefined) {
      this.body = args.body;
    }

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AggkitApiError);
    }
  }
}
