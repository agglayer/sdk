# `src/aggkit/__fixtures__`

Wire-format fixtures for the aggkit client tests. Every file here is a
**verbatim HTTP response body** captured from a running aggkit deployment —
never hand-written, never edited after capture. Tests must assert against
these bytes rather than against a hand-rolled object literal, so that a wire
format change upstream breaks a test instead of silently diverging from the
types.

## `activity_rc9_live_prefix.json` / `activity_rc9_live_postfix.json`

Live captures of the bridge tracker's cross-network activity endpoint, used by
`activity.test.ts` to pin the `global_index` precision workaround in
`parsing.ts` (`quoteGlobalIndex`).

|              |                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Endpoint     | `GET /tracker/v1/activity/from/{from_address}`                                                       |
| Address      | `0x8943545177806ED17B9F23F0a21ee5948eCaa776`                                                         |
| Environment  | 2-L2 anvil devnet (docker compose), aggkit-proxy fronting the bridge services and the bridge tracker |
| Capture date | 2026-09-08                                                                                           |

- **`activity_rc9_live_prefix.json` — the defect, as shipped.** Captured from
  aggkit `v0.11.0-rc9` (`origin/develop` at the time), unmodified. Its single
  activity row carries `global_index` in **both** encodings at once:
  `"global_index":18446744073709551618` as a **bare JSON number** under
  `bridge` (the embedded `bridgeservicetypes.BridgeResponse`, whose
  `GlobalIndex` is a `*big.Int` — the bug), and
  `"global_index":"18446744073709551618"` as a **quoted string** under `claim`
  (`ClaimResponse`, which already used aggkit's `BigIntString` wrapper). The
  value is `2^64 + 2` — above `Number.MAX_SAFE_INTEGER`, so a plain
  `JSON.parse` of this body corrupts the bridge-level field to
  `18446744073709552000` while the claim-level string survives intact.
- **`activity_rc9_live_postfix.json` — the same request once the upstream fix
  is in.** Captured from an aggkit image built from the branch that retypes
  `BridgeResponse.GlobalIndex` as `BigIntString`, landing as
  agglayer/aggkit#1835. **Both** occurrences are quoted, zero are bare. Its
  purpose is to prove `quoteGlobalIndex` is idempotent over the fixed wire
  format, i.e. that the SDK keeps working — and keeps returning the identical
  string — the day #1835 ships, so removing the workaround is a cleanup rather
  than a prerequisite.

The pre-fix image was overwritten by a later rebuild and cannot be
regenerated, so this capture is the only surviving copy of that wire format —
do not modify it.

**These are two separate runs of a deterministic environment (baked anvil
snapshot, fixed accounts/nonces/tx sequence), not one chain observed across an
upgrade.** Both runs replay the identical deposit sequence from identical
genesis, so the same logical deposit is reached in both — the bridge tx hash
`0xdefa988c...054e25f8`, `deposit_count: 2` and
`global_index: 18446744073709551618` are byte-identical across the two files —
but per-run values such as `block_num` and the timestamps differ, and should
not be compared between the two.

Both rows also happen to exercise several other review items at once, which is
why the tests assert against them directly:

- **L1-origin deposit**: `bridge_network_id: 0`, with a `global_index` above
  `2^64` (the encoding that only occurs for L1-origin deposits).
- **Claimed, with the claim joined in**: `claim_status: "claimed"` plus a
  populated `claim` and `claim_network_id`.
- **`proof_local_exit_root` / `proof_rollup_exit_root` are ABSENT** from
  `claim` — `ClaimResponse` declares them `omitempty`, which is why
  `AggkitActivityClaim` types them optional. Note that `mainnet_exit_root` and
  `rollup_exit_root` _are_ present, as single hash strings; they are different
  fields from the absent `proof_*` arrays.
- **Three different `from_address` encodings in one response**: top-level
  `from_address` lowercased (`common.Address.MarshalText`), `bridge.from_address`
  in the original mixed case, and `claim.from_address` an empty string.
