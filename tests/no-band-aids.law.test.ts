/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NO BAND-AIDS (CLAUDE.md 10.12, Dan 2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "I DO NOT WANT CRONS AND 'BACK PAY JOBS'! ... MAKE IT A HARD
 * RULE THAT IT IS NO LONGER ALLOWED TO CREATE ANYTHING THAT MONITORS AND BACK
 * FILLS OR ADJUSTS A PAYOUT OR ANY OTHER ISSUE ... I WANT HARD CODED FIXES AT
 * THE ROOT SOURCE WHEN AN ISSUE IS DISCOVERED! NOT A FUCKING BAND AID!"
 *
 * 10.11 already said a detector is not a fix, in writing, on 2026-09-06. The
 * day after, the platform still paid 558 payouts / 48,146.94 chips in seven
 * days through repair machinery instead of through the engine - median six
 * hours late, worst 84 days - and 29 of 127 active cron jobs were repair-shaped.
 * A rule with no reader gets re-derived one incident at a time.
 *
 * So this pins three things: the guard recognises a band-aid, the allowlist is
 * DEBT rather than a way through, and the register that says how each one dies
 * stays in step with it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const ROOT = resolve(__dirname, '..');
const ALLOWLIST_PATH = resolve(ROOT, 'scripts/ci/band-aid.allowlist.json');
const REGISTER_PATH = resolve(ROOT, 'docs/BAND-AIDS-REGISTER.md');
const CLAUDE_MD = resolve(ROOT, 'CLAUDE.md');
const EXECUTION_STANDARD = resolve(ROOT, 'docs/standards/EVENT-DRIVEN-EXECUTION.md');
const CANONICAL_ARCHITECTURE = resolve(
  ROOT,
  '.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md'
);

let isBandAidName: (n: string) => boolean;
let declaredFunctions: (sql: string) => string[];
let scheduledJobs: (sql: string) => { added: string[]; removed: string[] };
let offenders: (
  sql: string,
  allowed?: Set<string>,
  droppedElsewhere?: Set<string>
) => Array<{ kind: string; name: string }>;

beforeAll(async () => {
  const href = pathToFileURL(resolve(ROOT, 'scripts/ci/check-no-new-band-aids.mjs')).href;
  const mod = await import(/* @vite-ignore */ href);
  isBandAidName = mod.isBandAidName;
  declaredFunctions = mod.declaredFunctions;
  scheduledJobs = mod.scheduledJobs;
  offenders = mod.offenders;
});

describe('the guard knows a band-aid when it sees one', () => {
  it('recognises every shape the platform actually grew', () => {
    // Each of these is a real function or job on production today.
    for (const name of [
      'fn_rake_repair_unbanked',
      'fn_backpay_unfinalised_bounty_pools',
      'fn_pay_backed_payout_shortfalls',
      'fn_redrive_unbanked_rake',
      'fn_bbj_rollup_catchup',
      'fn_ca_ledger_day_manifest_backfill',
      'fn_heal_seat_provenance',
      'fn_tournament_payout_reconcile',
      'ca-bounty-backpay-hourly',
      'rake-repair-unbanked-hourly',
      'union-seat-provenance-heal',
    ]) {
      expect(isBandAidName(name), name).toBe(true);
    }
  });

  it('does not fire on ordinary names that merely contain the letters', () => {
    for (const name of [
      'fn_settle_tournament_obligation',
      'fn_healthcheck_ping', // "health", not "heal"
      'fn_ca_tournament_escrow',
      'fn_spin_settle_game',
      'fn_credit_and_log',
      'ca-supply-snapshot-hourly',
      'sp_prune_hand_history',
    ]) {
      expect(isBandAidName(name), name).toBe(false);
    }
  });

  it('reads a declaration out of a migration, and lets a DROP through', () => {
    const declares = `
      CREATE OR REPLACE FUNCTION public.fn_widget_repair_missing(p int)
      RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    `;
    expect(declaredFunctions(declares)).toContain('fn_widget_repair_missing');
    expect(offenders(declares)).toHaveLength(1);

    // Deleting a band-aid is the rule being obeyed, not broken.
    const drops = `${declares}\nDROP FUNCTION IF EXISTS public.fn_widget_repair_missing(int);`;
    expect(offenders(drops)).toHaveLength(0);
  });

  it('catches a new repair cron, and lets an unschedule through', () => {
    const adds = `SELECT cron.schedule('widget-repair-5m', '*/5 * * * *', $$SELECT 1$$);`;
    expect(scheduledJobs(adds).added).toContain('widget-repair-5m');
    expect(offenders(adds).map((o) => o.name)).toContain('widget-repair-5m');

    const removes = `${adds}\nSELECT cron.unschedule('widget-repair-5m');`;
    expect(offenders(removes)).toHaveLength(0);
  });

  it('never reads the words out of a comment or a quoted string', () => {
    // Every migration in this class quotes the words it is about. An earlier
    // guard in this directory was unusable until that was fixed.
    const prose = `
      -- This migration explains why fn_rake_repair_unbanked exists and does
      -- not create one. See 'fn_backpay_unfinalised_bounty_pools' for the
      -- shape we are removing.
      CREATE OR REPLACE FUNCTION public.fn_settle_tournament_obligation(p int)
      RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
    `;
    expect(offenders(prose)).toHaveLength(0);
  });

  it('lets a declaration through when a later migration in the same branch drops the name', () => {
    // 2026-09-07: the mirror of an applied migration declared reconcile_diamond_purchase_refund
    // (the live Stripe refund handler, badly named); the rename migration in the same branch
    // creates fn_diamond_purchase_refund and drops the old name. Declared here, dropped there,
    // is the rule being obeyed at branch scope.
    const mirror =
      'create or replace function public.reconcile_diamond_purchase_refund(uuid) returns jsonb language sql as $$ select 1 $$;';
    const rename =
      'create or replace function public.fn_diamond_purchase_refund(uuid) returns jsonb language sql as $$ select 1 $$; drop function if exists public.reconcile_diamond_purchase_refund(uuid);';
    expect(offenders(mirror)).toHaveLength(1);
    expect(
      offenders(mirror, new Set(), new Set(['reconcile_diamond_purchase_refund']))
    ).toHaveLength(0);
    expect(offenders(rename)).toHaveLength(0);
    // A name dropped elsewhere does not excuse a DIFFERENT band-aid in this file.
    expect(offenders(mirror, new Set(), new Set(['fn_something_else_repair']))).toHaveLength(1);
  });

  it('respects the allowlist, because a migration that FIXES one must land', () => {
    const sql = `CREATE OR REPLACE FUNCTION public.fn_rake_repair_unbanked(p int)
                 RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`;
    expect(offenders(sql)).toHaveLength(1);
    expect(offenders(sql, new Set(['fn_rake_repair_unbanked']))).toHaveLength(0);
  });
});

describe('the allowlist is debt, not a door', () => {
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  const entries: Array<{ name: string; register: string }> = raw.existing_debt;

  it('exists, and says in its own file what it is for', () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(String(raw._read_this_first)).toMatch(/may only ever get shorter/i);
  });

  it('every entry points at the register row that says how it dies', () => {
    for (const e of entries) {
      expect(e.name, JSON.stringify(e)).toBeTruthy();
      expect(e.register, e.name).toMatch(/^TIER [123]/);
    }
  });

  it('the register exists and names the two biggest by their real numbers', () => {
    expect(existsSync(REGISTER_PATH)).toBe(true);
    const reg = readFileSync(REGISTER_PATH, 'utf8');
    expect(reg).toContain('fn_tournament_payout_reconcile');
    expect(reg).toContain('fn_pay_backed_payout_shortfalls');
    // The measurement is the point: a register with no numbers is an opinion.
    expect(reg).toMatch(/48,146\.94/);
    expect(reg).toMatch(/74,544/);
  });

  it('holds no name the register has never heard of', () => {
    const reg = readFileSync(REGISTER_PATH, 'utf8');
    // Function names must appear; cron job names are grouped by tier in tables,
    // so only the fn_* half is asserted here.
    const missing = entries
      .map((e) => e.name)
      .filter((n) => n.startsWith('fn_'))
      .filter((n) => !reg.includes(n));
    expect(missing, `not in the register: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('the law is written down where agents read it', () => {
  const md = readFileSync(CLAUDE_MD, 'utf8');

  it('CLAUDE.md carries 10.12 with Dan’s words in it', () => {
    expect(md).toContain('## 10.12 NO BAND-AIDS');
    expect(md).toContain('NOT A FUCKING BAND AID');
    expect(md).toContain('docs/BAND-AIDS-REGISTER.md');
  });

  it('says plainly that a repair job firing is an incident, not a success', () => {
    expect(md).toMatch(/repair\s+job\s+firing\s+is\s+a\s+P0/i);
    expect(md).toMatch(/run\s+twice\s+for\s+the\s+same\s+cause\s+is\s+proof/i);
  });

  it('never describes cron as a correctness or release reconciler', () => {
    const standard = readFileSync(EXECUTION_STANDARD, 'utf8');
    const architecture = readFileSync(CANONICAL_ARCHITECTURE, 'utf8');
    expect(standard).toMatch(/Cron is limited to product-time behavior/);
    expect(standard).toMatch(/may not reconcile, heal,\s*retry, backfill, re-drive, or recover/);
    expect(standard).not.toMatch(/Cron may provide secondary reconciliation/i);
    expect(architecture).toMatch(/Cron is limited to product-time behavior/);
    expect(architecture).not.toMatch(/Cron may provide secondary reconciliation/i);
  });
});
