/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT PAYOUT IS A RECORD, NOT A COLUMN (2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this phase, the only evidence that a player finished 3rd and was paid
 * 42.50 was two MUTABLE columns on tournament_players — `position` and `prize`
 * — with no payment timestamp, no idempotency key, no snapshot of the
 * structure that priced the place, and no field size to say what that
 * structure was trimmed to. 44,091 completed tournaments; 52,847 prize
 * payments; zero rows of evidence.
 *
 * The moment the record existed it found money nobody could previously query:
 *
 *   39 completed MTTs paid out more than their prize pool, $20,407.66 over;
 *   Sunday Freeroll Special (2026-08-23) paid all NINE places TWICE, six and a
 *     half minutes apart — eighteen payments, $600 against a $300 pool —
 *     because the key was USER-scoped, so two different players stamped 1st
 *     produced two different keys and both were paid;
 *   833 events paid before the keyed path existed had no evidence at all.
 *
 * Every pin below is one of the properties that makes the record trustworthy.
 * If one turns red, the record has quietly become a cache again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', '..', '..', 'supabase', 'migrations');

const migration = (needle: string): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.includes(needle));
  if (!file) throw new Error(`no migration matching "${needle}" - was it renamed?`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

/**
 * Executable SQL only — every `--` comment line stripped.
 *
 * This exists because the first run of this file failed on its own rollback
 * block: the "no blanket USING (true)" pin matched the commented-out policy in
 * the ROLLBACK section, which is documentation, not something the database
 * will ever run. A pin that fires on a comment is a pin that will be deleted
 * the first time it is inconvenient.
 */
const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** The closed vocabulary of payment kinds the record is allowed to speak. */
const SOURCES = [
  'structure',
  'reconcile',
  'hu_shortfall',
  'bounty',
  'own_bounty',
  'late_reg_adjustment',
  'clawback',
  'final_table_deal',
  'mystery_bounty',
  'mystery_bounty_residual',
  'spin_backpay',
];

/** Entry-side money. A buy-in returned is not a prize won. */
const NEVER_A_PAYOUT = ['addon', 'rebuy', 'cancelrefund', 'bubbleprotection'];

describe('the payout record cannot be rewritten', () => {
  const guard = migration('the_payout_record_bypass_must_be_asked_for');

  it('refuses UPDATE and DELETE with a trigger, not with a convention', () => {
    const table = migration('a_tournament_payout_is_a_record_not_a_column');
    expect(table).toMatch(/BEFORE UPDATE OR DELETE ON public\.tournament_payouts/);
    expect(table).toContain('trg_tournament_payouts_append_only');
  });

  it('does not let a bare postgres session through - the bypass must be asked for', () => {
    // The first cut was `IF session_user = 'postgres' THEN <allow>`, which left
    // the guard off for every pg_cron job and every console query, and made it
    // impossible to test: a probe running as postgres could not tell a working
    // trigger from a broken one.
    expect(guard).toContain('app.payout_record_correction');
    expect(guard).toContain('i_am_correcting_the_record');
    expect(executable(guard)).not.toMatch(/IF session_user = 'postgres' THEN/);
  });

  it('names what a DBA must do, in the error itself', () => {
    expect(guard).toContain('HINT');
  });
});

describe('the deal path can live under an append-only table', () => {
  const deal = migration('the_deal_writes_its_record_once');

  it('never UPDATEs tournament_payouts - the remainder rides in on the insert', () => {
    expect(executable(deal)).not.toMatch(/UPDATE\s+public\.tournament_payouts/i);
  });

  it('still settles the flooring remainder on the chip leader', () => {
    expect(deal).toContain('v_remainder := v_undistributed - v_paid_out');
    expect(deal).toMatch(/v_p\.user_id = v_leader/);
  });

  it('shares the engine ftd key namespace so record and credit converge on one row', () => {
    expect(deal).toContain("':ftd:'");
    expect(deal).toContain('ON CONFLICT (idempotency_key)');
  });
});

describe('every prize writes its evidence at ONE chokepoint', () => {
  const credit = migration('the_record_reads_the_place_from_the_key');

  it('writes the record inside fn_credit_and_log, where all nineteen paths meet', () => {
    expect(credit).toContain('INSERT INTO public.tournament_payouts');
    expect(credit).toContain('fn_credit_and_log');
  });

  it('writes it ONLY for a tournament prize - cash settlement is untouched', () => {
    expect(credit).toMatch(
      /IF lower\(COALESCE\(p_category, ''\)\) = 'prize' AND p_related_entity_id IS NOT NULL THEN/
    );
  });

  it('runs after the credit is known to have moved, so a dedupe writes nothing', () => {
    const guardIdx = credit.indexOf('IF NOT v_credited THEN');
    const insertIdx = credit.indexOf('INSERT INTO public.tournament_payouts');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });

  it('fails OPEN on the record and LOUD - the credit commits, an alert is raised', () => {
    expect(credit).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(credit).toContain('financial_alerts');
    expect(credit).toContain('tournament_payout_record');
  });

  it('reads the place from the key rather than trusting twelve call sites to pass it', () => {
    expect(credit).toContain('fn_tournament_payout_shape');
    expect(credit).toContain('COALESCE(p_payout_position, v_shape_place)');
  });

  it('drops the nine-argument overload - two would make every RPC ambiguous', () => {
    const added = migration('every_prize_writes_its_own_evidence');
    expect(added).toMatch(
      /DROP FUNCTION IF EXISTS public\.fn_credit_and_log\(uuid, numeric, text, text, text, uuid, text, uuid, uuid\)/
    );
  });

  it('restores the ACL a DROP discards - this function mints money', () => {
    const added = migration('every_prize_writes_its_own_evidence');
    expect(added).toContain('REVOKE ALL ON FUNCTION public.fn_credit_and_log');
    expect(added).toContain('FROM PUBLIC, anon, authenticated');
    expect(added).toContain('TO service_role');
  });
});

describe('one classifier, so live rows and historical rows cannot drift', () => {
  const shape = migration('the_classifier_learns_the_three_keys_outside_the_tourney_namespace');
  const backfill = migration('the_back_catalogue_gets_its_evidence');
  const credit = migration('the_record_reads_the_place_from_the_key');

  it('is called by BOTH writers', () => {
    expect(credit).toContain('fn_tournament_payout_shape');
    expect(backfill).toContain('fn_tournament_payout_shape');
  });

  it('speaks exactly the closed vocabulary and nothing else', () => {
    for (const s of SOURCES) {
      expect(shape, `${s} is classifiable`).toContain(`'${s}'`);
    }
  });

  it('never classifies entry-side money as a payout', () => {
    for (const kind of NEVER_A_PAYOUT) {
      expect(shape, `${kind} must not be a payout source`).not.toContain(`'${kind}'`);
    }
  });

  it('covers the three namespaces that do not begin tourney:', () => {
    expect(shape).toContain("p_key LIKE 'mb:%'");
    expect(shape).toContain("p_key LIKE 'mb-residual:%'");
    expect(shape).toContain("p_key LIKE 'spin:%'");
  });

  it('is not executable by a browser role', () => {
    expect(shape).toContain('REVOKE ALL ON FUNCTION public.fn_tournament_payout_shape(text)');
    expect(shape).toContain('FROM PUBLIC, anon, authenticated');
  });
});

describe('the record does not leak what every player has ever won', () => {
  const table = migration('a_tournament_payout_is_a_record_not_a_column');

  it('drops the read-everything policy before the first row lands', () => {
    expect(table).toContain('DROP POLICY IF EXISTS tpay_read ON public.tournament_payouts');
  });

  it('scopes reads to self, the field of that event, and club administration', () => {
    expect(table).toContain('tpay_read_self_field_or_staff');
    expect(table).toContain('user_id = auth.uid()');
    expect(table).toContain('fn_is_club_admin_uid');
  });

  it('does not hand authenticated a blanket USING (true)', () => {
    expect(executable(table)).not.toMatch(/FOR SELECT TO authenticated\s+USING \(true\)/);
  });

  it('revokes the write grants RLS was silently carrying alone', () => {
    expect(table).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
    expect(table).toContain('REVOKE SELECT ON public.tournament_payouts FROM anon');
  });
});

describe('one row per movement of money', () => {
  it('makes the idempotency key unique, which is what makes retries converge', () => {
    const table = migration('a_tournament_payout_is_a_record_not_a_column');
    expect(table).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_payouts_idempotency_key'
    );
  });

  it('re-running the backfill inserts nothing', () => {
    const backfill = migration('the_back_catalogue_gets_its_evidence');
    const conflicts = backfill.match(/ON CONFLICT \(idempotency_key\)/g) ?? [];
    expect(conflicts.length).toBe(2); // one per arm
    expect(backfill).toContain('NOT EXISTS');
  });

  it('marks reconstructed rows so nobody mistakes them for contemporaneous ones', () => {
    const backfill = migration('the_back_catalogue_gets_its_evidence');
    expect(backfill).toContain("'backfill_2026_08_31'");
    expect(backfill).toContain("'backfill_ledger_2026_08_31'");
  });

  it('leaves payout_structure NULL on reconstructed rows rather than inventing one', () => {
    const backfill = migration('the_back_catalogue_gets_its_evidence');
    // A snapshot means "the structure as it stood when this place was priced".
    // Today's structure is not that, and a plausible wrong value is worse than
    // an empty one.
    expect(backfill).toMatch(/NULL, 'backfill_2026_08_31'/);
    expect(backfill).toMatch(/NULL, 'backfill_ledger_2026_08_31'/);
  });
});

describe('a clawback is a negative payout the record must admit', () => {
  it('allows a negative amount only for a clawback', () => {
    const c = migration('a_clawback_is_a_negative_payout_the_record_must_admit');
    expect(c).toContain("CHECK (amount >= 0 OR source = 'clawback')");
  });
});
