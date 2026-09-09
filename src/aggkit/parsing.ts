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
 * The tracker's `/tracker/v1/activity/from/{from_address}` endpoint has the
 * identical defect: its `ActivityItem.Bridge` field embeds
 * `bridgeservicetypes.BridgeResponse` unmodified, so `getActivity` needs
 * this same pre-quoting before `JSON.parse`.
 *
 * Upstream bug: `BridgeResponse.GlobalIndex` is declared `*big.Int` instead
 * of aggkit's own `BigIntString` wrapper, so it serializes as a bare number
 * even though aggkit's swagger declares it a string. Tracked at
 * https://github.com/agglayer/aggkit/issues/1820, fixed by
 * https://github.com/agglayer/aggkit/pull/1835 — delete this workaround once
 * the SDK's minimum supported aggkit version contains that fix.
 *
 * Until then, this function is safe to leave in place unconditionally:
 * confirmed on a live post-fix capture, it is idempotent over the already
 * `BigIntString`-quoted form `#1835` produces (`quoteGlobalIndex(x) === x`
 * when `x`'s `global_index` values are already quoted), because the regex
 * only matches a bare, unquoted run of digits. So this workaround keeps
 * working — as a no-op — once #1835 lands, and removing it is a cleanup,
 * not a fix for a break.
 *
 * SCOPE, precisely. The pattern is deliberately narrow, and matches only
 * `"global_index"` immediately followed by `:`, then optional whitespace,
 * then an optionally-signed run of decimal digits. Therefore it correctly
 * leaves alone: an already-quoted value (any amount of whitespace before
 * the opening quote), `null`, a different key that merely contains
 * `global_index` as a substring (`"x_global_index"`, `"global_index_x"`),
 * and any occurrence inside a string literal elsewhere in the payload
 * (which cannot be preceded by an unescaped `"` + `:` pair). It also does
 * NOT match a space *before* the colon (`"global_index" : 1`), and it
 * rewrites only the integer prefix of a non-integer number
 * (`1.8e19` -> `"1".8e19`, which then fails `JSON.parse`).
 *
 * Neither of those last two is reachable from aggkit: `encoding/json` never
 * emits whitespace before a colon, and `*big.Int`/`BigIntString` never
 * serialize a fraction or an exponent — a global index is at most ~2^65, so
 * even a lossy double round-trip through another JSON tool stays in fixed
 * notation (JS switches to exponent form only at 1e21). They are recorded
 * here so that a future producer change is evaluated against the pattern
 * rather than assumed safe.
 */
export function quoteGlobalIndex(raw: string): string {
  return raw.replace(/"global_index":\s*(-?\d+)/g, '"global_index":"$1"');
}
