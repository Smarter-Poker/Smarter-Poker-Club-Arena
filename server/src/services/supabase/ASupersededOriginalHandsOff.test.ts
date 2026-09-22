/**
 * A SUPERSEDED ORIGINAL HANDS OFF ITS RETAINED HAND (2026-09-22)
 *
 * On 2026-09-18 between 23:08 and 23:12 UTC engine process 1-3846b8bb retained
 * the exact request of 69 finished tournament hands, then its own lease proof
 * expired before it sent them ("atomic hand commit refused
 * (lease_proof_expired)"). The same process claimed each tournament lease
 * again under a new generation, and every new manager was refused at table
 * start with original_failure_or_handoff_unproven, because the database only
 * handed a retained hand to a successor when a DATABASE rollback had written a
 * failure row. Those tables never dealt again and their seats stayed taken.
 *
 * Migration 20260922022319 lets the verified current generation continue a
 * retained original whose generation it superseded. These tests pin both
 * halves of that contract: the engine asks with ITS OWN current generation and
 * accepts the exact receipt the PostgreSQL qualification returns, and the
 * newest database definition keeps the same-generation refusal while no longer
 * demanding a failure row from an original that never dispatched.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

vi.mock('./client.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));
vi.mock('./handProjection.js', () => ({
  wakeHandProjection: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));

import { resumeRetainedHandSubmission } from './handHistory.js';
import { supabase } from './client.js';

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;
const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, '../../../../supabase/migrations');

const TABLE = '86100000-0000-0000-0000-000000000001';
const SUBMISSION = '86400000-0000-0000-0000-000000000001';
const SUCCESSOR_GENERATION = '86500000-0000-0000-0000-000000000002';

/** The fields of the receipt scripts/ci/probes/hand-submission-superseded.sql
 *  returned from PostgreSQL 17 for a superseded original's handoff. */
const supersededReceipt = {
  found: true,
  completed: true,
  success: true,
  atomic_hand_commit: true,
  snapshot_completed: true,
  post_commit_completed: true,
  financial_handoff: true,
  table_id: TABLE,
  history_id: SUBMISSION,
  submission_id: SUBMISSION,
  submission_hash: '9324cf6025b0d80c14879a6de0c7e1d7bcd7f2248925b30cc511213c348bf1b5',
  hand_number: '8600001',
  permit_id: '86600000-0000-0000-0000-000000000001',
};

function latestResumeDefinition(): { file: string; body: string } {
  const files = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const text = readFileSync(resolve(migrations, file), 'utf8');
    const start = text.search(
      /CREATE (OR REPLACE )?FUNCTION public\.fn_ca_resume_hand_submission\(/
    );
    if (start < 0) continue;
    const open = text.indexOf('$function$', start);
    const close = text.indexOf('$function$', open + 10);
    found = { file, body: text.slice(open + 10, close) };
  }
  if (!found) throw new Error('fn_ca_resume_hand_submission has no migration');
  return found;
}

afterEach(() => vi.clearAllMocks());

describe('a superseded original hands off its retained hand', () => {
  it('asks the database with the successor generation it holds, not the original one', async () => {
    rpc.mockResolvedValueOnce({ data: { found: false }, error: null });
    await expect(
      resumeRetainedHandSubmission(TABLE, '1-3846b8bb', SUCCESSOR_GENERATION)
    ).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('fn_ca_resume_hand_submission', {
      p_table_id: TABLE,
      p_instance_id: '1-3846b8bb',
      p_lease_generation: SUCCESSOR_GENERATION,
    });
  });

  it('admits the deal on the exact receipt the qualified handoff returns', async () => {
    rpc.mockResolvedValueOnce({ data: supersededReceipt, error: null });
    await expect(
      resumeRetainedHandSubmission(TABLE, '1-3846b8bb', SUCCESSOR_GENERATION)
    ).resolves.toEqual({ handNumber: 8600001, submissionId: SUBMISSION });
  });

  it('still refuses the deal while the original generation is the caller', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        found: true,
        completed: false,
        submission_id: SUBMISSION,
        reason: 'original_failure_or_handoff_unproven',
      },
      error: null,
    });
    await expect(
      resumeRetainedHandSubmission(TABLE, '1-3846b8bb', '86500000-0000-0000-0000-000000000001')
    ).rejects.toThrow('retained_hand_submission_pending: original_failure_or_handoff_unproven');
  });

  it('a receipt for another table never admits this one', async () => {
    rpc.mockResolvedValueOnce({
      data: { ...supersededReceipt, table_id: '86100000-0000-0000-0000-000000000009' },
      error: null,
    });
    await expect(
      resumeRetainedHandSubmission(TABLE, '1-3846b8bb', SUCCESSOR_GENERATION)
    ).rejects.toThrow('retained_hand_submission_receipt_unproven');
  });

  it('the newest database definition admits a superseded original without a failure row', () => {
    const { file, body } = latestResumeDefinition();
    expect(file >= '20260922022319').toBe(true);
    // The original generation itself is still refused: it owns its own door.
    expect(body).toContain(
      "IF s.lease_generation=p_lease_generation THEN\n   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;"
    );
    // The refusal that froze 69 tables demanded a failure row an undispatched
    // original can never write.
    expect(body).not.toMatch(
      /s\.lease_generation=p_lease_generation OR NOT EXISTS\(SELECT 1 FROM smarter_private\.hand_submission_failures/
    );
    // The supersession is read from the lease this transaction holds.
    expect(body).toContain(
      'IF generation IS DISTINCT FROM p_lease_generation OR generation IS NOT DISTINCT FROM s.lease_generation THEN'
    );
    expect(body).toContain("'superseded_generation'");
    // Production tournament tables keep lifecycle NULL until they close.
    expect(body).toContain("AND (lifecycle='live' OR (tour IS NOT NULL AND lifecycle IS NULL)))");
    expect(body).not.toContain("AND lifecycle='live' AND lower(status)");
  });
});
