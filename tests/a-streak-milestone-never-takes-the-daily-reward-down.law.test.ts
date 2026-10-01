/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A STREAK MILESTONE NEVER TAKES THE DAILY REWARD DOWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A Daily Missions streak milestone (30 days 1,000; 60 days 2,500; 100 days
 * and every 30 after 6,000) used to be paid INSIDE the claim of a daily
 * reward, on the daily_missions line whose per-player daily cap is 500
 * (ruling 18). Once DR7:user_over_daily_cap refused rather than warned
 * (2026-09-26), every milestone of 1,000 or more was refused and took the
 * ordinary reward down with it, for as long as the streak lasted; and the
 * horse claim sweep, retrying the refused rows oldest first 500 a minute,
 * stopped paying every horse behind them. On 2026-09-30 3,053 horse rewards
 * were owed and 46 DR0:health_critical rows were open.
 *
 * Decided by Claude on Dan's delegation of 2026-09-30 and recorded under
 * ruling 18 in docs/DIAMOND-RULINGS.md, migration 20260930233000 pins:
 *
 *   1. the milestones have their own line, daily_mission_milestones, 6,000 a
 *      day for everyone, and the 500 of ruling 18 is not touched;
 *   2. the milestone step runs in its own subtransaction, so it can never
 *      roll the claim back;
 *   3. a milestone is written down when it is reached, paid one credit per
 *      milestone under its own reference, and a refused one stays owed and is
 *      tried again by the next daily claim - nothing deletes it;
 *   4. the sweep skips a row it cannot pay yet (deferred to its cap day, or
 *      ten minutes after a failure), keeps the 2026-09-24 lock order, and
 *      names a milestone refusal in its own column, never as `capped`.
 *
 * The migration is the one production ran (the rehearsal and the apply
 * record its md5); these pins keep a later edit from quietly undoing it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_streak_milestone_never_takes_the_daily_reward_down.sql'))
  .at(-1);
if (!NAME) throw new Error('the streak-milestone migration is missing');
const MIG = migrationText(NAME);
const RULINGS = readFileSync(resolve(__dirname, '..', 'docs', 'DIAMOND-RULINGS.md'), 'utf8');

/** Comments blanked, so a sentence in a header can never satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const section = (from: string, to: string) => sliceBetween(MIG, from, to);

const LINE = section(
  '-- 1. STREAK MILESTONES GET THEIR OWN LINE',
  '-- 2. A MILESTONE IS WRITTEN DOWN WHEN IT IS REACHED, AND PAID ON ITS OWN'
);
const AWARD = section(
  '-- 2. A MILESTONE IS WRITTEN DOWN WHEN IT IS REACHED, AND PAID ON ITS OWN',
  '-- 3. THE CLAIM NEVER WAITS ON THE MILESTONE'
);
const TRIGGER = section(
  '-- 3. THE CLAIM NEVER WAITS ON THE MILESTONE',
  '-- 4. THE SWEEP NEVER QUEUES BEHIND A REFUSAL'
);
const SWEEP = section(
  '-- 4. THE SWEEP NEVER QUEUES BEHIND A REFUSAL',
  '-- 5. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS'
);
const FINAL = code(section('-- 5. EVERY EDIT LANDED, AND THE ESTATE IS AS IT WAS', 'COMMIT;'));

/** The milestone step inside its own subtransaction, caught whole. */
const APART =
  /BEGIN\s+PERFORM public\.fn_award_daily_mission_milestones\(NEW\.user_id\);\s+EXCEPTION WHEN OTHERS THEN/;

/** The payment loop of the award: from its FOR to its END LOOP. */
const payLoop = (s: string) => sliceBetween(code(s), 'FOR v_owed IN', 'END LOOP;');

describe('LAW: a streak milestone never takes the daily reward down', () => {
  it('ships in one transaction, pins every body it changes, and proves itself live', () => {
    const body = code(MIG).trim();
    expect(body.startsWith('BEGIN;')).toBe(true);
    expect(body.endsWith('COMMIT;')).toBe(true);
    for (const md5 of [
      '44a39c35cc96801b5aa22a6ac930ee17',
      '077606e4e6fbd8c6c1eaf3c59cce35f9',
      'a8a8c804fdc1a3f43bbf1b587d2658a3',
      '6b0641992be63e1b9d9fe62ce44f4ff9',
    ]) {
      expect(code(MIG)).toContain(`'${md5}'`);
    }
    expect(MIG.match(/^-- @live-proof: .+$/gm)?.length).toBeGreaterThanOrEqual(3);
  });

  it('1. the milestones get their own 6,000 line, by asserted substitution, and ruling 18 keeps its 500', () => {
    const body = code(LINE);
    expect((body.match(/IF md5\(v_def\) <> '[0-9a-f]{32}' THEN/g) ?? []).length).toBe(1);
    expect((body.match(/IF md5\(replace\(/g) ?? []).length).toBe(1);
    expect(body).toContain("THEN ''daily_mission_milestones''\\n';");
    expect(body).toContain("= ''daily_mission_milestone'' THEN ''daily_mission_milestones''\\n'");
    expect(body).toContain("= ''daily_mission_reward'' THEN ''daily_missions''\\n';");
    expect(body).toMatch(/VALUES \('daily_mission_milestones', 6000, 6000,/);
    // Nothing in the migration moves the ruling 18 line, or any other cap.
    expect(code(MIG)).not.toMatch(/UPDATE\s+public\.diamond_engine_daily_caps/i);
    expect(code(MIG)).not.toMatch(/DELETE\s+FROM\s+public\.diamond_engine_daily_caps/i);
    expect(FINAL).toContain('a cap this migration must not touch has moved');
  });

  it('2. the claimed-row trigger runs the milestone step in its own subtransaction and never raises', () => {
    const body = code(TRIGGER);
    const fn = sliceBetween(
      body,
      'CREATE OR REPLACE FUNCTION public.fn_daily_missions_claimed_milestone()',
      '$function$;'
    );
    expect(fn).toMatch(APART);
    expect(fn).toContain("'CH3:milestone_step_failed'");
    expect(fn).not.toMatch(/RAISE\s+EXCEPTION/i);
    expect(fn).toContain("NEW.tier_snapshot = 'daily'");
    // the shape that stranded 160 horses: the award called bare, so its refusal was the claim's
    const bare =
      "IF NEW.claimed AND NOT OLD.claimed AND NEW.tier_snapshot = 'daily' THEN\n" +
      '    PERFORM public.fn_award_daily_mission_milestones(NEW.user_id);\n  END IF;';
    expect(bare).not.toMatch(APART);
  });

  it('3. a milestone is written down when reached, paid one credit at a time, and stays owed when refused', () => {
    const body = code(AWARD);
    // written down first, once
    expect(body.indexOf('INSERT INTO public.daily_challenge_milestone_claims')).toBeGreaterThan(0);
    expect(body.indexOf('ON CONFLICT DO NOTHING')).toBeLessThan(body.indexOf('FOR v_owed IN'));
    // owed means: no credit under its own reference in the journal
    expect(body).toContain('FROM public.diamond_transactions t');
    expect(body).toContain(
      "AND t.reference_id = 'daily_mission_milestones:' || c.user_id::text || ':'"
    );
    // each credit in its own subtransaction, through the one credit door, under its own reference
    const loop = payLoop(AWARD);
    expect(loop).toMatch(/BEGIN\s+v_credit := public\.add_diamonds_to_balance\(/);
    expect(loop).toContain("'daily_mission_milestone'");
    expect(loop).toContain('v_reference');
    expect(loop).toContain('EXCEPTION WHEN OTHERS THEN');
    expect(loop).toContain("'CH3:milestone_refused'");
    expect(loop).toContain("set_config('ca.daily_mission_milestones_refused', v_refused, true)");
    // a refusal is recorded and kept: nothing removes an unpaid milestone
    expect(body).not.toMatch(/DELETE\s+FROM\s+public\.daily_challenge_milestone_claims/i);
    expect(code(MIG)).not.toMatch(/DELETE\s+FROM\s+public\.daily_challenge_milestone_claims/i);
    // the precheck proves every earlier row reads as paid, so nothing is paid twice
    expect(code(MIG)).toContain('the owed state would pay them');
    // the one-aggregate credit that refused 1,000 as a single sum is gone
    expect(body).not.toContain('max(milestone_days)');
  });

  it('4. the sweep skips what it cannot pay yet, keeps its lock order, and names a milestone refusal', () => {
    const body = code(SWEEP);
    expect(body).toContain('CREATE TABLE public.ca_horse_claim_deferrals');
    expect(body).toContain(
      "CHECK (refused_by IN ('DR7:user_over_daily_cap', 'CH3:horse_claim_failed'))"
    );
    expect(body).toContain(
      'RETURNS TABLE(claimed integer, capped integer, failed integer, ran boolean, milestones_refused integer)'
    );
    // the candidate window skips a deferred row
    expect(body).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.ca_horse_claim_deferrals d\s+WHERE d\.challenge_row_id = u\.id AND d\.retry_after > now\(\)\)/
    );
    // a capped row waits for its cap day, a failed one ten minutes
    expect(body).toContain("AT TIME ZONE 'America/Chicago'");
    expect(body).toContain('v_retry := v_cap_resets;');
    expect(body).toContain("v_retry := now() + interval '10 minutes';");
    // the 2026-09-24 fix is kept: oldest first to choose, primary key order to lock
    expect(body).toContain('ORDER BY u.completed_at, u.id');
    const locking = /JOIN\s+oldest\b[\s\S]*?FOR\s+UPDATE\b[^\n]*/i.exec(body)?.[0] ?? '';
    expect(locking).toMatch(/ORDER\s+BY\s+u\.id\b/);
    expect(locking).toMatch(/FOR\s+UPDATE\s+OF\s+u\s+SKIP\s+LOCKED/);
    expect(locking).not.toMatch(/completed_at/);
    // the guards it already had
    for (const kept of [
      'fn_platform_frozen()',
      "pg_try_advisory_xact_lock(hashtext('ca_horse_claim_due'))",
      'claim_daily_challenge_serialized_body(r.user_id, r.id, NULL)',
      "'CH3:horse_claim_failed'",
      "LIKE '%DR7:user_over_daily_cap%'",
    ]) {
      expect(body).toContain(kept);
    }
    // milestone refusals are their own column, read from the milestone step, never folded into capped
    expect(body).toContain("set_config('ca.daily_mission_milestones_refused', '', true)");
    expect(body).toContain("current_setting('ca.daily_mission_milestones_refused', true)");
    // the job is kept exactly as it is: nothing scheduled, nothing unscheduled
    expect(code(MIG)).not.toMatch(/\bcron\s*\.\s*(un)?schedule\s*\(/i);
    expect(FINAL).toContain("command = 'SELECT public.fn_ca_horse_claim_due(500)'");
  });

  it('nothing it touches is reachable from a browser, and the books stay whole', () => {
    for (const sig of [
      'public.fn_award_daily_mission_milestones(uuid)',
      'public.fn_daily_missions_claimed_milestone()',
      'public.fn_ca_horse_claim_due(integer)',
    ]) {
      expect(code(MIG)).toContain(
        `REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`
      );
    }
    expect(code(MIG)).toContain(
      'REVOKE ALL ON public.ca_horse_claim_deferrals FROM PUBLIC, anon, authenticated;'
    );
    expect(FINAL).toContain("has_function_privilege('anon', r.oid, 'EXECUTE')");
    expect(FINAL).toContain('fn_ca_diamond_register_vs_supply()');
    expect(FINAL).toContain('this migration must not open the tournament door');
    expect(FINAL).toContain('watched guards off their baseline');
  });

  it("the decision is recorded under ruling 18, as decided by Claude on Dan's delegation", () => {
    const note = sliceBetween(RULINGS, '## Ruling 18 amended for streak milestones', '\n## ');
    expect(note).toContain("decided by Claude on Dan's delegation of 2026-09-30");
    expect(note).toContain('these are all for you to decide not me');
    expect(note).toContain('daily_mission_milestones');
    expect(note).toContain('6,000');
    expect(note).toContain('20260930233000');
  });
});
