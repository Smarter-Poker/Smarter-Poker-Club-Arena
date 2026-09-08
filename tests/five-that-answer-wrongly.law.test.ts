/**
 * FIVE THINGS THAT ANSWERED CONFIDENTLY WITHOUT KNOWING.
 *
 * An adversarial review raised seventeen items against the diamond work. Four
 * were settled in the migration before this one. **Two of the rest were not
 * defects at all**, and this file pins that finding too, because a fix applied
 * to something already right is a change with no upside and a cost:
 *
 *   * `fn_ca_diamond_engine_spent` was reported as disagreeing with the journal
 *     by 1,836,311 on daily_challenges. It is the frozen baseline plus the
 *     journal, by design, and the baseline accounts for the difference EXACTLY
 *     on all 34 period-engine rows. Measured, not assumed.
 *   * The RAISE in `fn_ca_diamond_offledger_float` was reported unreachable. It
 *     fires when `fn_ca_arena_diamonds()` returns NULL, which is a real outcome
 *     distinct from the function being absent.
 *
 * The five that were real share one shape - something answers, and the answer
 * does not depend on what it claims to (CLAUDE.md 10.86):
 *
 *  1. `fn_ca_is_cert_account` was SECURITY INVOKER while its twin
 *     `fn_ca_is_fixture_account`, doing the same job, was DEFINER. It reads
 *     `auth.users`, which `authenticated` cannot select from, so it answered one
 *     thing for service_role and another through any player-facing path. Eleven
 *     functions consult it, the collusion scan among them. **This is the second
 *     time these two disagreed in one day**: the earlier fix taught one of them
 *     that a horse is a player and missed the other.
 *  2. `diamond_reward_budgets.budget_diamonds` refuses nobody since ruling 21,
 *     yet reads as a control - and it was not merely wrong in a column. The
 *     bigint-max "unlimited" sentinel in `2026-10 / club_arena_daily` was being
 *     SUMMED into `fn_ca_diamond_trial_balance`, which printed
 *     "9,223,372,036,867,275,807 budgeted" on the one report a person reads to
 *     see whether the diamond books are sound.
 *  3. `ca_diamond_engine_spend` replaced a running total whose row lock
 *     serialised the platform and lost 5,861 awards. It is only trustworthy if
 *     immutable, and nothing enforced that.
 *  4. 297 `DR7:engine_over_budget` incidents belonged to a rule ruling 21
 *     removed. The forecast joins FROM the rule table, so they were invisible -
 *     not reported as retired, simply absent. Twelve retired rules were in that
 *     state once it could see them.
 *  5. The horse claim loop exists in two copies. They agree, and nothing could
 *     have noticed if they stopped.
 *
 * On (5): the copies are NOT merged, and the reason is not that it is hard. That
 * path is how 759 unclaimed rewards came back the same afternoon; restructuring
 * it and the settlement on one day is how a good change becomes an incident.
 * Merging them is owed work, recorded as such - and until then a normalising
 * function makes a silent divergence impossible.
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

describe('five that answer wrongly', () => {
  const sql = read('five_that_answer_wrongly');
  const body = code(sql);

  describe('1. a predicate answers the same for everyone', () => {
    it('makes the cert predicate SECURITY DEFINER, like its twin', () => {
      expect(body).toMatch(
        /CREATE OR REPLACE FUNCTION public\.fn_ca_is_cert_account[\s\S]{0,200}SECURITY DEFINER/
      );
    });

    it('asserts the two harness predicates run under the same security', () => {
      expect(body).toContain('count(DISTINCT prosecdef)');
      expect(body).toContain('still run under different security');
    });

    it('keeps a horse out of both of them (CLAUDE.md 10.5)', () => {
      expect(body).toContain('a horse still reads as harness equipment');
      expect(body).toContain('COALESCE(p.is_horse, false)');
    });

    it('still answers correctly for a real certification account', () => {
      expect(body).toContain('ca_cert_accounts');
      expect(body).toContain('no longer answers correctly for its real cases');
    });
  });

  describe('2. a budget is a plan, not a limit', () => {
    it('removes every sentinel and forbids another', () => {
      expect(body).toContain('ca_budget_is_a_number_or_nothing');
      expect(body).toContain('9223372036854775000');
      expect(body).toContain('a bigint-max sentinel was accepted');
    });

    it('makes "no plan" expressible, which is why the sentinel was invented', () => {
      expect(body).toContain('ALTER COLUMN budget_diamonds DROP NOT NULL');
    });

    it('says in the schema that it refuses nobody, and names what does', () => {
      expect(body).toContain('A PLAN, NOT A LIMIT');
      expect(body).toContain('diamond_engine_daily_caps');
    });

    it("does not invent the budget numbers, which are Dan's (CLAUDE.md 10.9)", () => {
      // Only the sentinel is changed. October's plans stay wrong until Dan sets them.
      expect(sql).toContain('THE OTHER TWO NUMBERS ARE NOT CHANGED HERE');
      expect(body).not.toMatch(
        /UPDATE public\.diamond_reward_budgets\s+SET budget_diamonds = [0-9]/
      );
    });

    it('reports which plans are fiction instead of leaving them to be rediscovered', () => {
      expect(body).toContain('fn_ca_diamond_budget_reality');
      expect(body).toContain('ALREADY OVER');
      expect(body).toContain('FUTURE PLAN BELOW PAST ACTUAL');
      expect(body).toContain('NO PLAN SET');
    });

    it('proves the sentinel left the trial balance, not just the column', () => {
      expect(body).toContain('still prints a sentinel-sized budget');
    });

    it('tolerates the six informational rows that carry a NULL difference by design', () => {
      // An earlier draft failed on those, which is the mistake this migration is about.
      expect(body).toMatch(
        /account IN \('player_diamonds','fixture_accounts','diamond_house','register','total'\)/
      );
    });
  });

  describe('3. the spend journal is append-only, enforced', () => {
    it('installs a BEFORE UPDATE OR DELETE trigger', () => {
      expect(body).toMatch(/BEFORE UPDATE OR DELETE ON public\.ca_diamond_engine_spend/);
    });

    it('proves the refusal by attempting an UPDATE', () => {
      expect(body).toContain('the engine spend journal accepted an UPDATE');
    });

    it('tells the reader to correct forward rather than edit history (CLAUDE.md 10.9)', () => {
      expect(body).toContain('Correct it forward with a new row');
    });
  });

  describe('4. a retired rule is visible, not absent', () => {
    it('reports retired rules that still hold incidents', () => {
      expect(body).toContain("'retired'::text");
      expect(body).toContain(
        'NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)'
      );
    });

    it('keeps the incidents rather than tidying them away', () => {
      expect(body).toContain('The rows are history and stay');
      expect(body).not.toMatch(/DELETE FROM public\.ca_diamond_incidents/i);
    });

    it('still reports its own blind spot, and keeps last_seen', () => {
      expect(body).toContain('(forecast confidence)');
      expect(body).toContain('last_seen');
      expect(body).toContain('is a FLOOR, not a total');
    });
  });

  describe('5. the two claim loops have one behaviour', () => {
    it('provides a normaliser rather than comparing raw text', () => {
      expect(body).toContain('fn_ca_normalise_claim_loop');
      expect(body).toContain("'END LOOP'");
    });

    it('tolerates the two differences that are deliberate: the self-name and comments', () => {
      expect(body).toContain("'SELF'");
      expect(sql).toContain('correctly names itself');
    });

    it('fails if the loops diverge in behaviour', () => {
      expect(body).toContain('diverged in behaviour');
    });

    it('cannot be satisfied by a loop emptied of its body', () => {
      expect(body).toContain('claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL)');
      expect(body).toContain(
        'no longer pays, no longer matches the cap precisely, or no longer exits'
      );
    });

    it('records merging them as owed work rather than pretending it is done', () => {
      expect(sql).toContain('I HAVE NOT MERGED THEM AND THE REASON IS');
    });
  });

  describe('the whole migration', () => {
    it('moves no money and proves it', () => {
      expect(body).toContain('players + float <> register after a change that moves no money');
    });

    it('creates nothing scheduled and nothing that repairs (CLAUDE.md 10.12)', () => {
      expect(body).not.toMatch(/cron\.schedule/i);
      expect(body).not.toMatch(
        /CREATE\s+(OR REPLACE\s+)?FUNCTION[^;]{0,200}(_repair_|_backpay_|_redrive_|_sweep_|_catchup_|_heal_)/i
      );
    });

    it('records the two items that were not defects, with the measurement', () => {
      expect(sql).toContain('TWO WERE NOT DEFECTS AT ALL');
      expect(sql).toContain('Measured, not assumed');
    });
  });
});
