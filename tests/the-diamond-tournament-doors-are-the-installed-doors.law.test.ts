/**
 * LAW: the Diamond tournament fixture tests the doors production runs, and an
 * md5 guard is never weakened to make a fixture build.
 * ═══════════════════════════════════════════════════════════════════════════
 * The ten Phase 8 Diamond tournament migrations edit live function text IN
 * PLACE and pin the md5 of the text they were written against. That pin is the
 * only thing standing between an in-place edit and a silently different money
 * function, so replaying those migrations onto any base that is not their
 * exact preimage fails - by design.
 *
 * On 2026-09-19 a lane building this fixture hit that wall and reached for the
 * one change that makes it go away: rewriting the md5 comparisons to `<> NULL`
 * across ten financial migrations. It was refused, and it must stay refused.
 * The fixture takes the other road: it CAPTURES the installed result and pins
 * it, so the doors it exercises are provably the doors production runs.
 *
 * This law holds the capture honest from the repository side alone - it opens
 * no database and needs no credential:
 *
 *   1. every `-- @@PIN md5=` in the capture equals the md5 of the definition
 *      printed under it, so the file cannot be hand-edited and stay valid;
 *   2. the capture's manifest names exactly the doors the capture carries;
 *   3. the set of Phase-8-named functions ABSENT from the capture is exactly
 *      the documented exclusion list, each entry carrying its reason, so a
 *      door cannot drop out of scope without a visible diff;
 *   4. no md5 comparison anywhere in supabase/migrations/ has been turned into
 *      a comparison against NULL, which is what "make the fixture build"
 *      looked like the first time.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CAPTURE = join(ROOT, 'tests', 'sql', 'diamond-tournament-doors-captured.sql');
const MANIFEST = join(ROOT, 'tests', 'sql', 'diamond-tournament-doors-captured.manifest.json');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

/** The ten migrations that put the Diamond tournament doors in production. */
const PHASE_8 = [
  '20260913235649_the_diamond_seat_guards_know_a_tournament_seat.sql',
  '20260914024241_a_diamond_tournament_entry_is_custody.sql',
  '20260914032315_a_diamond_tournament_pays_from_its_own_custody.sql',
  '20260914034708_a_diamond_tournament_door_answers_the_client.sql',
  '20260914040416_the_diamond_tournament_doors_state_their_grants.sql',
  '20260914041258_the_diamond_tournament_money_doors_are_watched.sql',
  '20260914043752_the_diamond_tournament_ledger_indexes_its_arena.sql',
  '20260914111558_a_diamond_rebuy_proves_its_generation.sql',
  '20260914111709_a_diamond_bounty_is_paid_from_its_own_bank.sql',
  '20260914113514_a_diamond_mystery_chest_holds_whole_diamonds.sql',
];

/**
 * What the capture's scope is, stated as a list rather than left as a gap.
 *
 * The capture covers the Diamond tournament ENTRY-AND-OBLIGATION closure: the
 * create, register, unregister, refund, cancel, pay, drain, settle-fee and
 * custody doors, plus everything those doors call, to closure. The ten Phase 8
 * migrations also touch functions OUTSIDE that closure, and each one is named
 * here with the reason it is out. This map is asserted to be exactly the set
 * of Phase-8-named functions absent from the capture, so a door cannot join
 * the exclusions quietly - adding one is a visible diff with a reason on it.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  // The bounty, PKO and mystery-bounty banks. The programme puts bounties,
  // satellites and reserves in Phase 9; the Phase 8 migrations reach them only
  // to teach chip readers of "bounty paid" about the Diamond ledger.
  fn_bounty_obligation_has_complete_marker: 'bounty bank, Phase 9 lane',
  fn_claim_tournament_bounty_elimination: 'bounty claim, Phase 9 lane',
  fn_collect_bounty: 'bounty bank, Phase 9 lane',
  fn_finalize_bounty_pool: 'bounty residual, Phase 9 lane',
  fn_mystery_bounty_reserve: 'mystery chest, Phase 9 lane',
  fn_mystery_bounty_seed: 'mystery chest, Phase 9 lane',
  fn_mystery_bounty_settle: 'mystery chest, Phase 9 lane',

  // The chip estate's own terminal settlement. tests/fixtures/tournament-fee-
  // lifecycle already exercises it against the full-schema runner; capturing it
  // here would pull the whole financial estate into this fixture.
  atomic_cancel_tournament: 'chip terminal settlement, tournament-fee-lifecycle owns it',
  fn_ca_commit_hand_settlement: 'chip hand settlement, accounting suites own it',
  fn_ca_process_tournament_chip_purchase_money_v1: 'chip rebuy money path',
  fn_ca_settle_hand_stacks_absolute: 'chip hand settlement, accounting suites own it',
  fn_ca_tournament_terminal_receipt: 'chip terminal receipt',
  fn_complete_tournament_terminal_pre_seat_guard: 'chip terminal writer',
  fn_credit_and_log: 'shared chip wallet writer; the Diamond pay door must never reach it',
  fn_payout_guarantee_check: 'chip guarantee watch',
  fn_settle_tournament_rake: 'chip rake settlement',

  // Estate-wide guards the Phase 8 migrations name while asserting their own
  // effects. Neither is a tournament door: one belongs to the profile lane and
  // one to the arena identity lane.
  fn_guard_profile_privileged_columns: 'profile column guard, profile lane',
  fn_poker_guard_arena_structure: 'arena identity guard, arena lane',
};

interface Door {
  identity: string;
  md5: string;
  len: number;
  body: string;
}

function readDoors(): Door[] {
  const text = readFileSync(CAPTURE, 'utf8');
  const re =
    /-- @@DOOR ([^\n]+)\n-- @@PIN md5=([0-9a-f]{32}) len=(\d+) owner=\S+\n([\s\S]*?);\nALTER FUNCTION /g;
  const out: Door[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ identity: m[1], md5: m[2], len: Number(m[3]), body: `${m[4]}\n` });
  }
  return out;
}

describe('the Diamond tournament doors are the installed doors', () => {
  const doors = readDoors();

  it('carries a readable, non-trivial set of captured doors', () => {
    expect(doors.length).toBeGreaterThanOrEqual(75);
  });

  it('every captured door matches the md5 pinned above it', () => {
    const wrong = doors.filter(
      (d) => createHash('md5').update(d.body).digest('hex') !== d.md5 || d.body.length !== d.len
    );
    expect(wrong.map((d) => d.identity)).toEqual([]);
  });

  it('the manifest names exactly the doors the capture carries', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      doors: { identity: string; md5: string }[];
    };
    expect(manifest.doors.map((d) => d.identity).sort()).toEqual(
      doors.map((d) => d.identity).sort()
    );
    expect(manifest.doors.map((d) => d.md5).sort()).toEqual(doors.map((d) => d.md5).sort());
  });

  it('every Phase 8 door is inside the capture', () => {
    const captured = new Set(doors.map((d) => d.identity.replace(/\(.*$/s, '')));
    const named = new Set<string>();
    for (const file of PHASE_8) {
      const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
      for (const re of [
        /CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_0-9]+)\(/g,
        /pg_get_functiondef\('public\.([a-z_0-9]+)/g,
        /proname\s*=\s*'([a-z_0-9]+)'/g,
      ]) {
        for (let m = re.exec(sql); m !== null; m = re.exec(sql)) named.add(m[1]);
      }
    }
    const missing = [...named].filter((n) => !captured.has(n)).sort();
    expect(missing).toEqual(Object.keys(OUT_OF_SCOPE).sort());
    for (const [name, reason] of Object.entries(OUT_OF_SCOPE)) {
      expect(reason.length, `${name} needs a reason, not a blank`).toBeGreaterThan(8);
    }
  });

  it('no migration compares an md5 against NULL', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(MIGRATIONS)) {
      if (!name.endsWith('.sql')) continue;
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
      if (/md5\s*\([^)]*\)\s*(?:<>|=|IS(?:\s+NOT)?\s+DISTINCT\s+FROM)\s*NULL/i.test(sql)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
