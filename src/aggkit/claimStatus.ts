/**
 * Helpers over `AggkitClaimStatus` (`claim_status` of the bridge tracker's
 * activity rows and tracking data).
 */

import type { AggkitClaimStatus } from './types';

/**
 * "Is this bridge claimed?" — `true` for both `'claimed'` (claimed, but the
 * claim's block can still be removed by a reorg) and `'claimed_finalized'`
 * (claimed and final, since tracker `api_revision` 7).
 *
 * Use it instead of comparing with `'claimed'`: against a tracker at
 * `api_revision` 7 a `claim_status === 'claimed'` check stops matching a
 * bridge as soon as its claim becomes final. Against a tracker at
 * `api_revision` 6, which only ever sends `'claimed'`, it behaves exactly
 * like that comparison.
 *
 * It does not say whether the claim is final: for that, compare with
 * `'claimed_finalized'`. `null`/`undefined` (e.g. the `claim_status` of an
 * absent `tracking`) are accepted and return `false`.
 */
export function isAggkitClaimedStatus(
  status: AggkitClaimStatus | null | undefined
): status is 'claimed' | 'claimed_finalized' {
  return status === 'claimed' || status === 'claimed_finalized';
}
