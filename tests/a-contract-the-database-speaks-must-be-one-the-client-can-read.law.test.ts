/**
 * ===========================================================================
 *  LAW: A CONTRACT THE DATABASE SPEAKS MUST BE ONE THE CLIENT CAN READ
 * ===========================================================================
 *
 * 2026-09-23. Four Diamond Spins migrations were applied straight to
 * production - the estate's documented way of shipping schema - and the
 * session ended without merging the client that matched them:
 *
 *   20260923032317  diamond_spins_prize_legs_keep_their_ledger_rows
 *   20260923032519  diamond_spins_daily_settlement_burns_twenty_percent
 *   20260923033010  the_first_step_of_a_bonus_game_never_ruins_it_and_the_floor
 *   20260923033605  diamond_wheel_v4_draws_a_different_prize_every_time
 *
 * `fn_wheel_state_v2` returned `contract_version: 4`. The deployed client
 * accepts 2 or 3 - `WheelContractVersion`, and `assertWheelAward`, which
 * throws "The Wheel Award Could Not Be Confirmed" on anything else. The wheel
 * was dead in production for about nine hours and nobody was told.
 *
 * WHY NOTHING CAUGHT IT. Every gate in this repo compares the repo against the
 * repo, or the repo against a SNAPSHOT of the schema:
 *
 *   check-migrations-applied       the branch's migrations vs a snapshot
 *   check-migrations-are-live      a merged migration vs the live catalogue
 *   check-applied-migrations-are-recorded  what production applied that the
 *                                  repo has no file for
 *
 * The third of those is the closest, and it answers "is there a file", not
 * "can the client read what that file did". A migration can be recorded, be
 * live, have its file on main, and still have moved a contract the client
 * cannot parse. Nothing compared what the DATABASE SAYS against what the
 * CLIENT CAN HEAR, in either direction.
 *
 * WHAT THE GUARD MUST KEEP BEING.
 *
 *  - It must read BOTH SIDES, never a list somebody maintains by hand. The
 *    live side is pg_get_functiondef / pg_get_constraintdef / pg_proc.prosrc
 *    and the live segments function executed read-only; the client side is the
 *    client's own type unions and assertions.
 *  - It must FAIL CLOSED in both directions: forward (a migration moves a
 *    contract past the client in its branch) and backward (a client drops a
 *    contract with no migration retiring it).
 *  - It must never report agreement it did not observe. No credential, an
 *    unreadable answer, or a client that stopped declaring its accepted set,
 *    are all exit 2 - COULD NOT TELL - and never exit 0.
 *  - It must have readers, and they are named here: ci.yml for the half a
 *    pull request can decide, and production-integrity-audit.yml for the live
 *    half. CLAUDE.md 10.86 rule 3; three detectors in this repo once asked
 *    production a question and were wired to nothing.
 *  - The client declarations it parses must keep existing. A refactor that
 *    moves WheelContractVersion somewhere else does not make the guard wrong,
 *    it makes it BLIND, and a blind guard reporting green is the disease.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// The law drives the CHECK's own exported functions, never a lookalike of its
// own: a guard that disagrees with the thing it guards is worse than no guard.
import {
  CLIENT_FILES,
  CannotTell,
  clientContract,
  contractFactsInSql,
  declaredMirrors,
  disagreements,
  liveContract,
  scrub,
  sourceVerdict,
  typeUnion,
} from '../scripts/ci/check-diamond-contract-parity.mjs';

const ROOT = path.resolve(__dirname, '..');
const CHECK = 'scripts/ci/check-diamond-contract-parity.mjs';
/** The two readers. Without them this is a guard nobody hears. */
const PR_READER = '.github/workflows/ci.yml';
const LIVE_READER = '.github/workflows/production-integrity-audit.yml';
/** The negative controls: the gates that already existed and did not ask this. */
const SNAPSHOT_GATE = 'scripts/ci/check-migrations-applied.mjs';
const OPPOSITE_GATE = 'scripts/ci/check-applied-migrations-are-recorded.mjs';

const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readOrNull = (p: string) =>
  fs.existsSync(path.join(ROOT, p)) ? fs.readFileSync(path.join(ROOT, p), 'utf8') : null;
const SRC = read(CHECK);

/**
 * PRODUCTION AS IT STOOD ON 2026-09-23, read off the live catalogue with the
 * check's own --live mode and pasted here. It is a RECORD OF AN OBSERVATION
 * used to drive the comparison logic in a test; the guard itself never reads a
 * recording, which is what the "reads the live catalogue" assertions below
 * pin.
 */
const LIVE_2026_09_23 = {
  contract_versions: [4],
  model_versions: ['wheel-v4'],
  segments_fn: 'fn_wheel_v4_segments',
  segment_count: 12,
  upgrade_segment_count: 8,
  prize_kinds: ['bonus', 'chips', 'diamonds', 'rabbit_hunt', 'throwables', 'time_bank', 'upgrade'],
  bonus_games: ['crash', 'crossing', 'mines', 'plinko'],
  bonus_floor_fns: ['fn_diamond_bonus_floor'],
  min_payout_version: 4,
  receipt_constraints: ['crash_rounds CHECK ((payout_version >= 4))'],
};

describe('a contract the database speaks must be one the client can read', () => {
  it('reads the live catalogue, not a snapshot of it', () => {
    // The snapshot is what let the existing gates pass a contract production
    // had already moved past.
    expect(SRC).toContain('pg_get_functiondef');
    expect(SRC).toContain('pg_get_constraintdef');
    expect(SRC).toContain('pg_proc');
    expect(SRC).not.toContain('supabase-schema-manifest.json');
    expect(SRC).not.toContain('schema-manifest.d');
    // And it EXECUTES the live model function rather than reading its source,
    // so the segment count and the prize vocabulary are measured, not parsed.
    expect(SRC).toContain('jsonb_array_length');
    // Read-only, always: no DDL and no writes on this path.
    expect(SRC).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE)\s+(INTO|TABLE|FUNCTION|FROM|OR|POLICY|ALL)\b/
    );
  });

  it('never passes when it cannot ask', () => {
    expect(SRC).toContain('COULD NOT TELL');
    expect(SRC).toContain('COULD NOT ASK THE DATABASE');
    expect(SRC).toContain('process.exit(2)');
    expect(SRC).toMatch(/process\.env\.SUPABASE_DB_URL \|\| process\.env\.DATABASE_URL/);
    // A client that stopped declaring its accepted set is also COULD NOT TELL.
    expect(SRC).toContain('class CannotTell');
    expect(() => typeUnion('export type Other = 1;', 'WheelContractVersion', 'x.ts')).toThrow(
      CannotTell
    );
  });

  it('never prints a credential', () => {
    // CLAUDE.md 10.84. psql echoes the conninfo it was handed in several of
    // its own error messages, so everything on the way to the log is scrubbed.
    process.env.SUPABASE_DB_URL = 'host=example port=5432 password=hunter2';
    try {
      const out = scrub('connection to host=example port=5432 password=hunter2 failed');
      expect(out).not.toContain('hunter2');
      expect(scrub('postgresql://postgres:sekrit@db.example:5432/postgres')).not.toContain(
        'sekrit'
      );
    } finally {
      delete process.env.SUPABASE_DB_URL;
    }
    expect(SRC).not.toMatch(/\.env['"\s]/);
  });

  it('cannot silently decline to run', () => {
    // The entry guard compares REAL paths on both sides. Spelled the usual
    // way it compares the invocation path as given, and a run through a
    // symlinked directory then executes nothing and exits 0 - which is this
    // law's own failure mode wearing the guard's name.
    expect(SRC).toContain('realpathSync');
    expect(SRC).toContain('invokedDirectly');
  });

  it('a guard must have a reader, and both of this one`s are named', () => {
    const pr = read(PR_READER);
    expect(pr).toContain('check-diamond-contract-parity.mjs --source');
    // In the job the required check TypeScript Check depends on, beside the
    // other Supabase invariants, so it BLOCKS rather than merely reporting.
    expect(pr).toMatch(/Supabase Invariants — The Diamond Spins Contract The Client Can Read/);
    const live = read(LIVE_READER);
    expect(live).toContain('check-diamond-contract-parity.mjs --live');
    // Its exit code has to reach the job conclusion, or the reader is decorative.
    expect(live).toContain('steps.diamondcontract.outputs.code');
    expect(live).toMatch(/\$DIAMOND"? = 0|"\$DIAMOND" = 0/);
    // The live half carries the credential; the pull-request half must not,
    // so a pull request never depends on production being reachable. The
    // window is bounded by the next sibling step, never by a byte count:
    // tests/helpers/sourceWindow.ts, and the 39-minute publish outage behind it.
    const STEP =
      '      - name: Supabase Invariants — The Diamond Spins Contract The Client Can Read';
    const after = pr.slice(pr.indexOf(STEP) + STEP.length);
    const sibling = after.indexOf('\n      - name:');
    const step = sibling === -1 ? after : after.slice(0, sibling);
    expect(step).not.toContain('DATABASE_URL');
    expect(step).toContain('check-diamond-contract-parity.mjs --source');
  });

  it('the client still declares everything this guard reads', () => {
    // If any of these disappears the guard goes blind, and a blind guard
    // reporting green is exactly what cost nine hours.
    const client = clientContract(readOrNull);
    expect(client.contract_versions.length).toBeGreaterThan(0);
    expect(client.draw_domains.length).toBeGreaterThan(0);
    expect(client.prize_kinds).toContain('bonus');
    expect(client.bonus_games.sort()).toEqual(['crash', 'crossing', 'mines', 'plinko']);
    expect(Number.isInteger(client.segment_count)).toBe(true);
    expect(Number.isInteger(client.upgrade_segment_count)).toBe(true);
    expect(client.bonus_floor_fns.length).toBeGreaterThan(0);
    for (const fn of client.bonus_floor_fns) expect(fn).toMatch(/^fn_diamond_bonus_/);
    expect(client.payout_versions.length).toBeGreaterThan(0);
    // And the files it reads are the ones it names in every message.
    for (const p of [
      CLIENT_FILES.service,
      CLIENT_FILES.award,
      CLIENT_FILES.floor,
      ...CLIENT_FILES.receipts,
    ])
      expect(fs.existsSync(path.join(ROOT, p)), `${p} is named by the guard and must exist`).toBe(
        true
      );
  });

  it('a live answer this client cannot read is reported, one sentence per surface', () => {
    const client = clientContract(readOrNull);
    const found = disagreements(LIVE_2026_09_23, client);
    if (client.contract_versions.includes(4)) {
      // The client has caught up with production. Then the recorded drift is
      // no longer a disagreement about the contract version, and the law's
      // job is to prove the comparison still LOOKS - which the v2 case below
      // does against the same client.
      expect(found.every((s) => !s.includes('contract_version 4,'))).toBe(true);
    } else {
      expect(found.join('\n')).toContain('contract_version 4');
      expect(found.join('\n')).toContain(CLIENT_FILES.service);
    }
    // A client that dropped a contract production still speaks is the same
    // failure from the other end, and lands in the same comparison.
    const narrowed = {
      ...client,
      contract_versions: [99],
      model_versions: ['wheel-v99'],
      draw_domains: ['wheel-v99'],
    };
    expect(disagreements(LIVE_2026_09_23, narrowed).length).toBeGreaterThan(0);
    // Agreement is agreement: nothing invented.
    const matching = {
      ...client,
      contract_versions: [...client.contract_versions, 4],
      model_versions: [...client.model_versions, 'wheel-v4'],
      draw_domains: [...client.draw_domains, 'wheel-v4'],
      prize_kinds: [...new Set([...client.prize_kinds, ...LIVE_2026_09_23.prize_kinds])],
      bonus_games: [...new Set([...client.bonus_games, ...LIVE_2026_09_23.bonus_games])],
      segment_count: LIVE_2026_09_23.segment_count,
      upgrade_segment_count: LIVE_2026_09_23.upgrade_segment_count,
      bonus_floor_fns: [...new Set([...client.bonus_floor_fns, 'fn_diamond_bonus_floor'])],
      payout_versions: [...client.payout_versions, 4],
    };
    expect(disagreements(LIVE_2026_09_23, matching)).toEqual([]);
  });

  it('reads a migration for what it declares, on every surface', () => {
    const facts = contractFactsInSql(
      `CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p_club_id uuid) RETURNS jsonb AS $f$\n` +
        `  SELECT jsonb_build_object('contract_version',4,'model_version','wheel-v4',\n` +
        `    'segments',public.fn_wheel_v4_segments(100,100,false,false));\n` +
        `$f$ LANGUAGE sql;\n` +
        `ALTER TABLE public.crash_rounds ADD COLUMN payout_version integer CHECK(payout_version>=4);\n` +
        `CREATE FUNCTION public.fn_diamond_bonus_floor(p_bet numeric) RETURNS numeric AS $$ SELECT 1 $$ LANGUAGE sql;`
    );
    expect(facts.contract_versions).toEqual([4]);
    expect(facts.model_versions).toEqual(['wheel-v4']);
    expect(facts.model_generations).toEqual([4]);
    expect(facts.payout_versions).toEqual([4]);
    expect(facts.declared_bonus_fns).toEqual(['fn_diamond_bonus_floor']);

    // A FACT COUNTS ONLY WHERE IT IS DECLARED. Measured on 2026-09-23 across
    // the 3,292 migrations on main, a whole-file parser claimed a Diamond
    // Spins contract fact in fourteen of them and SEVEN were false - four
    // stats migrations whose 'contract_version' belongs to a different
    // contract entirely, and the bonus LIFECYCLE functions (_start, _state,
    // _latest, _immutable, _replay, _share, _spin_ticket_guard), none of
    // which is a floor rule. CLAUDE.md is explicit about what a gate with
    // that hit rate becomes: switched off.
    expect(
      contractFactsInSql(
        `CREATE FUNCTION public.fn_stats_overview() RETURNS jsonb AS $$\n` +
          `  SELECT jsonb_build_object('contract_version',2);\n$$ LANGUAGE sql;`
      ).contract_versions
    ).toEqual([]);
    // Adding a sibling to the bonus family is not moving the floor: the
    // verdict needs the migration to name a rule the client mirrors too.
    const sibling = `CREATE FUNCTION public.fn_diamond_bonus_share(p uuid) RETURNS void AS $$ SELECT 1 $$ LANGUAGE sql;`;
    const client = clientContract(readOrNull);
    expect(
      sourceVerdict(client, client, [{ file: 'supabase/migrations/x.sql', sql: sibling }])
    ).toEqual([]);
    expect(
      sourceVerdict(client, client, [
        {
          file: 'supabase/migrations/20260923033010_the_floor.sql',
          sql:
            `CREATE FUNCTION public.fn_diamond_bonus_unheard_of(p numeric) RETURNS numeric AS $$ SELECT 1 $$ LANGUAGE sql;\n` +
            `DO $$ BEGIN EXECUTE replace(x,'public.${client.bonus_floor_fns[0]}(a,b)','public.fn_diamond_bonus_unheard_of(a,b,c,d)'); END $$;`,
        },
      ]).join('\n')
    ).toContain('fn_diamond_bonus_unheard_of');
  });

  it('the mirrors are a set, because a receipt keeps the rule it was sealed under', () => {
    // THE ONE THAT WOULD HAVE BLOCKED THE FIX. The correct client for the
    // 2026-09-23 change keeps diamondBonusMinimum for receipts sealed under
    // the old rule and adds the new one beside it. Read as a single name, this
    // guard would have seen only the retired rule and failed the very pull
    // request that ends the outage.
    const both =
      `/** Mirrors public.fn_diamond_bonus_minimum(p_bet, p_boost). Kept for old receipts. */\n` +
      `export function diamondBonusMinimum() {}\n` +
      `/** Mirrors public.fn_diamond_bonus_floor(p_bet, p_boost, p_paid_diamonds, p_rate). */\n` +
      `export function diamondBonusFloor() {}\n`;
    expect(declaredMirrors(both, 'x.ts')).toEqual([
      'fn_diamond_bonus_floor',
      'fn_diamond_bonus_minimum',
    ]);
    const client = clientContract(readOrNull);
    const live = { ...LIVE_2026_09_23, bonus_floor_fns: ['fn_diamond_bonus_floor'] };
    const caughtUp = { ...client, bonus_floor_fns: declaredMirrors(both, 'x.ts') };
    expect(disagreements(live, caughtUp).join('\n')).not.toContain('fn_diamond_bonus');
    // A mirror the client drops while production still opens rounds with it is
    // the same outage from the other end, and is still refused.
    const dropped = { ...client, bonus_floor_fns: ['fn_diamond_bonus_minimum'] };
    expect(disagreements(live, dropped).join('\n')).toContain('fn_diamond_bonus_floor');
  });

  it('accuses no migration on main: a gate with a false-positive rate gets switched off', () => {
    // The whole history, against the client that is on this tree. Every one of
    // the 3,292 migrations already merged describes a contract this client can
    // read, so not one of them may be refused.
    const client = clientContract(readOrNull);
    const dir = path.join(ROOT, 'supabase', 'migrations');
    const accused: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      if (sourceVerdict(client, client, [{ file, sql }]).length) accused.push(file);
    }
    expect(
      accused,
      'these migrations are already on main and already live, so refusing them is a false ' +
        'accusation. Scope the fact to the declaration that makes it, not to the file.'
    ).toEqual([]);
  });

  it('fails closed forward: a migration cannot outrun the client in its own branch', () => {
    const base = clientContract(readOrNull);
    const V4 =
      `CREATE OR REPLACE FUNCTION public.fn_wheel_state_v2(p uuid) RETURNS jsonb AS $$\n` +
      `  SELECT jsonb_build_object('contract_version',4,'model_version','wheel-v4');\n$$ LANGUAGE sql;`;
    const problems = sourceVerdict(base, base, [
      { file: 'supabase/migrations/20260923033605_diamond_wheel_v4.sql', sql: V4 },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain('20260923033605');
    expect(problems.join('\n')).toContain(CLIENT_FILES.service);
    // And when the client in the same branch does accept it, it passes.
    const widened = {
      ...base,
      contract_versions: [...new Set([...base.contract_versions, 4])],
      model_versions: [...new Set([...base.model_versions, 'wheel-v4'])],
      draw_domains: [...new Set([...base.draw_domains, 'wheel-v4', 'wheel-v4-upgrade'])],
    };
    expect(
      sourceVerdict(base, widened, [
        { file: 'supabase/migrations/20260923033605_diamond_wheel_v4.sql', sql: V4 },
      ])
    ).toEqual([]);
  });

  it('fails closed backward: the client cannot drop what production may still speak', () => {
    const base = clientContract(readOrNull);
    const dropped = {
      ...base,
      contract_versions: base.contract_versions.slice(1),
      draw_domains: base.draw_domains.slice(1),
    };
    const problems = sourceVerdict(base, dropped, []);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(/carries no migration that retires it/);
  });

  it('the negative control: neither existing gate asks this question', () => {
    const snapshot = read(SNAPSHOT_GATE);
    expect(snapshot).toContain('supabase-schema-manifest.json');
    expect(snapshot).not.toContain('contract_version');
    expect(read(OPPOSITE_GATE)).not.toContain('WheelContractVersion');
    expect(SRC).not.toEqual(snapshot);
  });

  it('the live reader is a function, so it cannot quietly become a recording', () => {
    // liveContract takes the asking function. Handed something that answers
    // nothing, it refuses rather than reporting agreement.
    expect(() => liveContract(() => '')).toThrow(CannotTell);
    expect(() => liveContract(() => '0')).toThrow(CannotTell);
  });
});
