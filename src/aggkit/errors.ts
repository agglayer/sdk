/**
 * aggkit API Error
 *
 * Thrown by `AggkitBridgeClient` for every non-2xx HTTP response it actually
 * receives. Distinct from the core `ApiError` (`../core/utils/apiError.ts`) —
 * aggkit's error bodies are a uniform bare `{"error": "<message>"}` shape (no
 * `code`/`name`/`details`), so this class carries `httpStatus` + `endpoint` +
 * the raw `body` instead.
 *
 * NOT thrown for a network/transport failure after retries are exhausted
 * (audit finding C4): `httpRaw.ts`'s `fetchRawText` throws a plain `Error`
 * (`{ cause: lastError }`) in that case, before any HTTP response ever
 * reaches the code that would construct an `AggkitApiError` — there is no
 * status code or body to carry. A caller distinguishing "aggkit answered
 * badly" (`AggkitApiError`) from "the request never got a response"
 * (plain `Error`, inspect `.cause`) should branch on `instanceof
 * AggkitApiError` accordingly.
 *
 * Never used for "the request succeeded, the deposit is simply not claimable
 * yet" — that is modelled as data (`AggkitProbeResult` /
 * `AggkitClaimInputsResult`), not as an exception (comments 3847523270 /
 * 3847600104).
 */

export interface AggkitApiErrorArgs {
  message: string;
  httpStatus: number;
  endpoint: string;
  body?: string;
}

export class AggkitApiError extends Error {
  public override readonly name: string = 'AggkitApiError';
  /** HTTP status code: 400/404/500/502/503 for server errors (502 = aggkit-proxy backend unreachable). */
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
