/**
 * A FLIP DATE WITH NOBODY TO ACT ON IT IS A DATE THAT PASSES.
 *
 * Nine diamond rules in `ca_diamond_rule_modes` carry a `flip_after` date on
 * which they stop logging and start refusing. Three dates: 2026-09-14,
 * 2026-09-22, 2026-10-08. A week of work went into making those dates safe -
 * the flip forecast, the cap headroom report, the VIP cap fix, the settlement of
 * 759 expiring horse rewards. All of it to answer one question: what will this
 * refuse on the day it arms?
 *
 * **Nothing armed them.** `fn_ca_diamond_rule_flip` is the only thing that sets
 * mode to `refuse`, and measured on production 2026-09-08: zero cron jobs called
 * it, zero database functions called it, no application caller existed. The four
 * `ca-diamond-*` jobs are snapshot, trial balance and prune history. So
 * `flip_after` was a date on which nothing happened, nine rules would have sat
 * in `log` mode for ever, and every instrument built to make the transition safe
 * was reporting on a transition that would not occur.
 *
 * It is worth being blunt about the mechanism, because it is not carelessness
 * and it will recur: **the elaborate safety apparatus is what hid it.** Everyone
 * - me included - kept checking whether the flip was SAFE. Nobody checked
 * whether it was CONNECTED. CLAUDE.md's engine-restart handoff records finding
 * three more guards of exactly this shape, and 10.86 is the general statement of
 * it.
 *
 * The pins below are the four parts of the fix, and one of them is a mistake
 * this file's own first draft made:
 *
 *  1. **A hand.** `fn_ca_diamond_rule_flip_due()` on a daily tick. Not a repair
 *     job (10.12) - it repairs nothing; its schedule IS the product, because
 *     `flip_after` is a date and a date needs something that notices it. It
 *     decides nothing either: arming was decided when each rule was written.
 *  2. **A fourth gate.** It arms only when the forecast reports zero would-refuse
 *     SINCE THE RULE'S CONFIGURATION LAST CHANGED. The forecast stops being a
 *     report somebody might read and becomes the gate.
 *  3. **A real configuration epoch.** Both config tables carried `updated_at`
 *     and neither had a trigger, so the column recorded whatever the last writer
 *     happened to set - my own cap change at 14:33 left it reading 05:05. An
 *     epoch the configuration does not update is worse than none, because (2)
 *     trusts it.
 *  4. **A dry run that runs the same gates.** The first draft checked only the
 *     new forecast gate and then reported "every gate passes", so all nine rules
 *     read as ready to arm while the real flip would have refused every one on
 *     its date - and the health report counts blocked rows, so it would have
 *     called the subsystem healthy on the strength of a check it had not run.
 *     The defect this migration exists to fix, reintroduced one level up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
const code = (sql: string) => sql.replace(/--[^\n]*/g, '');

describe('the flip has a hand', () => {
  const sql = read('the_flip_had_no_hand');
  const body = code(sql);

  describe('1. something arms the rules', () => {
    it('creates the sweep and schedules it', () => {
      expect(body).toContain('fn_ca_diamond_rule_flip_due');
      expect(body).toContain("cron.schedule('ca-diamond-rule-flip-daily'");
    });

    it('does not schedule a duplicate if one already exists', () => {
      expect(body).toMatch(
        /WHERE NOT EXISTS \(SELECT 1 FROM cron\.job WHERE jobname = 'ca-diamond-rule-flip-daily'\)/
      );
    });

    it('asserts the schedule is active rather than assuming the insert worked', () => {
      expect(body).toContain('nothing is scheduled to arm the rules');
    });

    it('reports every rule it cannot arm instead of skipping it', () => {
      // "blocked" and "nothing to do" must never read the same (CLAUDE.md 10.86).
      expect(body).toContain('the flip sweep returned a row with no reason');
      expect(body).toMatch(/'blocked'::text/);
    });

    it('reports on every log-mode rule, not a subset', () => {
      expect(body).toContain('the flip sweep reported on % of % log-mode rules');
    });

    it('leaves a trace of each run, so a dead scheduler and a quiet week differ', () => {
      expect(body).toContain('DR0:rule_flip_sweep');
    });
  });

  describe('2. the forecast is the gate, counted since the configuration changed', () => {
    it('blocks on would-refuse since the config epoch, not on the raw window', () => {
      expect(body).toContain('v_fc.since_config > 0');
    });

    it('blocks when the forecast cannot cover the rule at all', () => {
      // An unreadable answer is never a pass.
      expect(body).toContain('the forecast does not cover this rule');
    });

    it('reports since_config and config_at beside the window total', () => {
      expect(body).toContain('since_config');
      expect(body).toContain('config_at');
    });

    it('says in words when the evidence predates the configuration change', () => {
      expect(body).toContain('SAFE TO ARM SINCE THE CONFIGURATION CHANGED');
      expect(body).toContain('Read the first number');
    });

    it('knows the cap rule is configured by a second table', () => {
      expect(body).toMatch(/DR7:user_over_daily_cap' THEN v_caps/);
    });

    it('asserts since_config can never exceed the window total', () => {
      expect(body).toContain('exceeds the window total');
    });
  });

  describe('3. the configuration epoch is real', () => {
    it('stamps updated_at on both configuration tables', () => {
      expect(body).toContain('fn_ca_touch_updated_at');
      expect(body).toMatch(/BEFORE INSERT OR UPDATE ON public\.diamond_engine_daily_caps/);
      expect(body).toMatch(/BEFORE INSERT OR UPDATE ON public\.ca_diamond_rule_modes/);
      expect(body).toContain('both configuration tables must stamp updated_at');
    });

    it('tests the stamp with equality, because now() does not advance in a transaction', () => {
      expect(body).toContain('IS DISTINCT FROM now()');
      expect(sql).toContain('advance inside a transaction');
    });
  });

  describe('4. the dry run runs the same gates as the real thing', () => {
    it('checks the arming date', () => {
      expect(body).toContain('may not arm before');
    });

    it('checks the clean-days requirement', () => {
      expect(body).toContain('not clean');
      expect(body).toContain('clean_days_required');
    });

    it('checks that some function actually consults the rule', () => {
      expect(body).toContain('arming it would change nothing');
    });

    it('never arms anything, and that is asserted', () => {
      expect(body).toContain('the dry run armed a rule');
    });
  });

  describe('the front door', () => {
    it('exists and leads with whether the flip has a hand', () => {
      expect(body).toContain('fn_ca_diamond_health');
      expect(body).toContain('does not lead with whether the flip has a hand');
    });

    it('says NOTHING ARMS THE RULES in words when the schedule is missing', () => {
      expect(body).toContain('NOTHING ARMS THE RULES');
    });

    it('distinguishes a live coverage gap from one that has stopped', () => {
      expect(body).toContain('STILL HAPPENING');
      expect(body).toContain('appears fixed');
      expect(body).toContain('does not say whether the gap is live or stopped');
    });

    it('counts only rules past their date as overdue, so the row is not always amber', () => {
      expect(body).toMatch(/m\.flip_after <= now\(\)/);
      expect(sql).toContain('teach whoever reads it to ignore the row');
    });

    it('carries the class of defect that cost 759 rewards', () => {
      expect(body).toContain('unclaimed rewards');
      expect(body).toContain('a horse claims only when a new engine event arrives');
    });

    it('asserts the instrument works, not that the platform is perfect', () => {
      expect(sql).toContain('ASSERT THE INSTRUMENT WORKS, NOT THAT THE PLATFORM IS PERFECT');
      expect(body).toContain('an area this migration is responsible for is not ok');
    });

    it('refuses a status outside the three it defines', () => {
      expect(body).toContain("h.status NOT IN ('ok','attention','critical')");
    });
  });

  describe('the whole migration', () => {
    it('moves no money and proves it', () => {
      expect(body).toContain('players + float <> register after a change that moves no money');
    });

    it('creates nothing that repairs, backfills or compensates (CLAUDE.md 10.12)', () => {
      expect(body).not.toMatch(
        /CREATE\s+(OR REPLACE\s+)?FUNCTION[^;]{0,200}(_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_)/i
      );
    });

    it('states why a scheduled flip is not a band-aid', () => {
      expect(sql).toContain('It is NOT a repair job');
      expect(sql).toContain('Its schedule\n--    IS the product');
    });
  });
});
