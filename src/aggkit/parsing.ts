/**
 * BigInt-safe parsing helpers for aggkit responses.
 *
 * `global_index` is a bare JSON number on `/bridges` (and would exceed
 * `Number.MAX_SAFE_INTEGER` for L1-origin deposits, e.g.
 * `18446744073709551621`). Default `JSON.parse` silently corrupts such
 * values into an imprecise IEEE-754 double. The fix is
 * to quote the bare integer with a regex BEFORE calling `JSON.parse`, so
 * `global_index` always parses as a `string`.
 *
 * This is idempotent for `/claims`, where `global_index` is already a JSON
 * string — the regex only matches an unquoted run of digits.
 *
 * Upstream bug: `BridgeResponse.GlobalIndex` is declared `*big.Int` instead
 * of aggkit's own `BigIntString` wrapper, so it serializes as a bare number
 * even though aggkit's swagger declares it a string. Tracked at
 * https://github.com/agglayer/aggkit/issues/1820 — delete this workaround
 * once the minimum supported aggkit emits `global_index` as a string.
 */
export function quoteGlobalIndex(raw: string): string {
  return raw.replace(/"global_index":\s*(-?\d+)/g, '"global_index":"$1"');
}
