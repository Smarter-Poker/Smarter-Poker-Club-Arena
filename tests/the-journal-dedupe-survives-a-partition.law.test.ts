/**
 * THE JOURNAL'S DEDUPE SURVIVES A PARTITION.
 *
 * Dan ruled on 2026-09-07 that `chip_ledger` keeps every leg for ever,
 * partitioned by month. Postgres requires every UNIQUE index on a partitioned
 * table to include the partition key, so `ux_chip_ledger_idempotency_key`
 * would become `(idempotency_key, created_at)` - which is not a weaker version
 * of the same guarantee but a different one: the same key in two different
 * months would both be accepted. That is the double-record defect fixed on
 * `tournament_payouts` on 2026-09-06, re-introduced into the journal itself.
 *
 * So the guarantee lives OUTSIDE the journal now, in `chip_ledger_idem`, which
 * is never partitioned and never dropped with a partition. Measured before
 * building: of 2,004,587 legs exactly 1,611 carry an idempotency key, so the
 * companion is a small table and the trigger does nothing at all on 99.92% of
 * inserts.
 *
 * What this pins, from the migration text:
 *
 *   1. the claim table exists and is keyed BY the idempotency key, so a second
 *      claim is a primary-key violation rather than a check somebody can skip;
 *   2. the trigger returns early when there is no key - the hot path stays hot;
 *   3. the claim insert carries NO `ON CONFLICT`, because the violation IS the
 *      refusal and it has to reach the caller;
 *   4. the old unique index is NOT dropped - both mechanisms run together
 *      until the cut, so a disagreement is a bug found while both are still
 *      there to compare;
 *   5. the backfill is proved exact in BOTH directions, not just by count.
 *
 * The live behaviour was proved separately and rolled back, per CLAUDE.md 11.5:
 * a real keyed leg inserted into `chip_ledger` had its key claimed by the
 * trigger with the claim naming that leg, and a second leg carrying the same
 * key was refused with a unique violation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const file = files.find((f) => f.includes('the_journal_dedupe_survives_a_partition'));
const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

/** SQL with its comments stripped - the header quotes the very things being pinned. */
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');

describe('the journal dedupe survives a partition', () => {
  it('the migration exists', () => {
    expect(file, 'the dedupe companion migration must not be deleted').toBeTruthy();
  });

  it('the claim table is keyed by the idempotency key itself', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.chip_ledger_idem/);
    expect(sql).toMatch(/idempotency_key text PRIMARY KEY/);
  });

  it('it is engine-only: no browser role can read or write the claims', () => {
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.chip_ledger_idem FROM PUBLIC, anon, authenticated/
    );
    expect(sql).toMatch(/GRANT SELECT, INSERT ON TABLE public\.chip_ledger_idem TO service_role/);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('the trigger does nothing when there is no key, so the hot path stays hot', () => {
    const body = code(sql).slice(
      code(sql).indexOf('CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once')
    );
    expect(body).toMatch(/IF NEW\.idempotency_key IS NULL THEN\s+RETURN NEW;/);
  });

  it('the claim carries no ON CONFLICT: the violation is the refusal', () => {
    const body = code(sql).slice(
      code(sql).indexOf('CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once'),
      code(sql).indexOf('$function$;', code(sql).indexOf('zz_chip_ledger_key_is_claimed_once'))
    );
    expect(body).toContain('INSERT INTO public.chip_ledger_idem');
    expect(body).not.toMatch(/ON CONFLICT/i);
  });

  it('the old unique index is left in place until the cut', () => {
    expect(code(sql)).not.toMatch(/DROP\s+INDEX[^;]*ux_chip_ledger_idempotency_key/i);
  });

  it('the backfill is proved exact in both directions, not by count alone', () => {
    expect(sql).toMatch(/EXCEPT/);
    expect(sql).toMatch(/VERIFY FAILED: % keyed leg\(s\) have no claim row/);
    expect(sql).toMatch(/VERIFY FAILED: % claim row\(s\) name a key no leg carries/);
    expect(sql).toMatch(/VERIFY FAILED: % keyed legs against % claims/);
  });

  it('a probe that could not run says so rather than passing quietly', () => {
    expect(sql).toContain('CLAIM_PROBE_NOT_RUN');
  });
});
