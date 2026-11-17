import { describe, it, expect, expectTypeOf } from 'vitest';
import { isAggkitClaimedStatus } from '../claimStatus';
import { isAggkitClaimedStatus as fromModuleIndex } from '../index';
import { isAggkitClaimedStatus as fromSdkRoot } from '../../index';
import type {
  AggkitActivityFilter,
  AggkitActivityItem,
  AggkitActivityResult,
  AggkitBridgeStatus,
  AggkitClaimStatus,
} from '../types';

// ---------------------------------------------------------------------------
// Tracker api_revision 7 (agglayer/sdk#46): the `claimed_finalized` status,
// the "is it claimed?" helper, and type-level acceptance of the new value and
// of the new OPTIONAL fields (a tracker at api_revision 6 does not send them).
// ---------------------------------------------------------------------------

describe('isAggkitClaimedStatus', () => {
  it.each(['claimed', 'claimed_finalized'] as const)(
    'is true for %s',
    (status) => {
      expect(isAggkitClaimedStatus(status)).toBe(true);
    }
  );

  it.each(['pending', 'readyToClaim', 'error'] as const)(
    'is false for %s',
    (status) => {
      expect(isAggkitClaimedStatus(status)).toBe(false);
    }
  );

  it('is false for a missing status (e.g. no `tracking` on the row)', () => {
    expect(isAggkitClaimedStatus(undefined)).toBe(false);
    expect(isAggkitClaimedStatus(null)).toBe(false);
  });

  it('is false for a value this SDK version does not know', () => {
    // A future tracker may add states; an unknown one is not "claimed".
    expect(isAggkitClaimedStatus('whatever' as AggkitClaimStatus)).toBe(false);
  });

  it('covers every AggkitClaimStatus', () => {
    // Exhaustive by construction: adding a member to the union without
    // deciding here whether it counts as claimed is a compile error.
    const expected: Record<AggkitClaimStatus, boolean> = {
      pending: false,
      readyToClaim: false,
      claimed: true,
      claimed_finalized: true,
      error: false,
    };
    for (const [status, claimed] of Object.entries(expected)) {
      expect(isAggkitClaimedStatus(status as AggkitClaimStatus)).toBe(claimed);
    }
  });

  it('narrows the status to the two claimed values', () => {
    const status = 'claimed_finalized' as AggkitClaimStatus;
    if (isAggkitClaimedStatus(status)) {
      expectTypeOf(status).toEqualTypeOf<'claimed' | 'claimed_finalized'>();
    } else {
      expectTypeOf(status).toEqualTypeOf<
        'pending' | 'readyToClaim' | 'error'
      >();
    }
  });

  it('is exported from the aggkit module and from the SDK root', () => {
    expect(fromModuleIndex).toBe(isAggkitClaimedStatus);
    expect(fromSdkRoot).toBe(isAggkitClaimedStatus);
  });
});

describe('tracker api_revision 7 types', () => {
  it('AggkitClaimStatus accepts claimed_finalized', () => {
    expectTypeOf<'claimed_finalized'>().toMatchTypeOf<AggkitClaimStatus>();
    expectTypeOf<AggkitClaimStatus>().toEqualTypeOf<
      'pending' | 'readyToClaim' | 'claimed' | 'claimed_finalized' | 'error'
    >();
  });

  it('AggkitActivityFilter keeps the five server-side values (claimed_finalized is not a filter)', () => {
    expectTypeOf<AggkitActivityFilter>().toEqualTypeOf<
      'all' | 'pending' | 'readyToClaim' | 'claimed' | 'error'
    >();
  });

  it('the new fields are optional, with the wire types', () => {
    expectTypeOf<AggkitActivityItem['finalized']>().toEqualTypeOf<
      boolean | undefined
    >();
    expectTypeOf<AggkitActivityResult['revision']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<AggkitBridgeStatus['block_finalized']>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it('accepts both an api_revision 6 and an api_revision 7 shaped value', () => {
    // api_revision 6: none of the new fields.
    const rev6: Pick<AggkitActivityResult, 'count' | 'warnings'> & {
      bridges: [];
    } = { bridges: [], count: 0, warnings: [] };
    expectTypeOf(rev6).toMatchTypeOf<AggkitActivityResult>();

    // api_revision 7: all of them.
    const rev7 = {
      bridges: [],
      count: 0,
      revision: `v1:${'0'.repeat(64)}`,
      warnings: [],
    } satisfies AggkitActivityResult;
    expect(rev7.revision).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});
