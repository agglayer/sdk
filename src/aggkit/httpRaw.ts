/**
 * Raw-text HTTP GET helper for aggkit responses.
 *
 * `core/utils/httpClient.ts`'s `HttpClient` is the SDK's general-purpose
 * fetch wrapper, but it calls `response.json()` internally
 * (`httpClient.ts:158`) and hands back already-parsed data — which would
 * silently corrupt the bare-number `global_index` on `/bridges` responses
 * (see `parsing.ts`). `AggkitBridgeClient` needs the raw response TEXT before
 * any JSON parsing happens, so this module re-implements `HttpClient`'s
 * retry/backoff/timeout policy (same defaults, same exponential-backoff
 * algorithm, same retryable-error heuristic) around `fetch`, returning the
 * raw body text and HTTP status instead of parsed JSON. This keeps
 * `core/utils/httpClient.ts` itself untouched while preserving its retry
 * semantics for the aggkit client.
 */

export interface RawFetchConfig {
  timeout: number;
  retries: number;
  retryDelay: number;
}

export interface RawFetchResult {
  status: number;
  text: string;
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('fetch')
    );
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchRawText(
  url: string,
  config: RawFetchConfig
): Promise<RawFetchResult> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= config.retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      clearTimeout(timeoutId);

      lastError =
        error instanceof Error && error.name === 'AbortError'
          ? new Error(`Request timeout after ${config.timeout}ms`)
          : (error as Error);

      if (attempt === config.retries || !isRetryableError(lastError)) {
        break;
      }

      await delay(config.retryDelay * Math.pow(2, attempt));
    }
  }

  throw new Error(
    `Request failed after ${config.retries} retries: ${lastError?.message ?? 'Unknown error'}`,
    { cause: lastError }
  );
}
