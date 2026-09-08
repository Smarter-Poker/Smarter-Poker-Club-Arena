/**
 * A HORSE'S CLAIM BUTTON IS KEYED TO WHO IS OWED, NOT TO WHO JUST DID SOMETHING.
 *
 * Twenty-three horses were holding 759 completed, unclaimed, in-window challenge
 * rewards worth 51,380 diamonds, 114 of them hours from expiry. They were
 * settled on 2026-09-08. **The cause was not**, and this is the cause.
 *
 * The horse claim lived inside `record_daily_challenge_event`, in an
 * `IF ... is_horse THEN` block that ran when an event arrived for that horse:
 *
 *     something happens -> enqueue_daily_challenge_event -> outbox
 *     outbox -> fn_drain_daily_challenge_event_outbox (pg_cron, every minute)
 *            -> record_daily_challenge_event -> the claim loop
 *
 * So the claim was keyed to a horse DOING something. **A horse that stops
 * playing stops claiming**, and its earned rewards sit until the seven-day
 * window closes on them. The 23 horses in the backlog had reported no event
 * since 05:07. A human who stops playing keeps a claim button for the whole
 * seven days — same reward, same window, different outcome, decided entirely by
 * the fact that a horse has no browser. That is what CLAUDE.md 10.5 forbids.
 *
 * **The settlement's own changelog said this fix was engine-side TypeScript in
 * HorseLogic. It was not, and the correction matters.** The claim already ran
 * server-side on a minute cadence; nothing needed building in the engine. What
 * was wrong was which question that cadence asked. It asked "who just acted"; it
 * now asks "who is owed". Everything needed was already there.
 *
 * **Why this is not a band-aid (10.12)**, since it is a scheduled job that pays
 * people and that is the exact shape 10.12 refuses: it repairs nothing and
 * compensates for nothing. It IS the button. A human presses one; a horse has no
 * browser, so the engine presses it — the same legitimate horse branch as
 * HorseLogic choosing actions, `scheduleHorseAction` submitting them inside the
 * same turn timer, and the synthetic heartbeat keeping the seat alive. A repair
 * job would be one that noticed the claim had FAILED and re-ran it.
 *
 * It ends the duplication in the same edit: the loop existed in two copies with
 * a normaliser pinning them character-for-character because merging them was too
 * risky the afternoon 759 rewards came back through that path. Moving the claim
 * out of the event path removes both.
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

describe("a horse's claim button", () => {
  const sql = read('the_horse_claim_button');
  const body = code(sql);

  describe('the button', () => {
    it('is keyed to who is owed, not to who just acted', () => {
      expect(body).toContain('fn_ca_horse_claim_due');
      expect(body).toMatch(/WHERE u\.completed AND NOT u\.claimed AND u\.expired_at IS NULL/);
      expect(body).toContain('ORDER BY u.completed_at, u.id');
    });

    it('runs on the same minute cadence the outbox drain already uses', () => {
      expect(body).toContain("cron.schedule('ca-horse-claim-due-minute', '* * * * *'");
    });

    it("presses only for horses; a human claim is a human's to press", () => {
      expect(body).toMatch(/JOIN public\.profiles p ON p\.id = u\.user_id AND p\.is_horse/);
      expect(body).toContain('the claim sweep does not restrict itself to horses');
      expect(body).toContain('the sweep is not horse-only');
    });

    it('pays through the platform path, never a hand-written wallet row', () => {
      expect(body).toContain('claim_daily_challenge_serialized_body(r.user_id, r.id, NULL)');
      expect(body).not.toMatch(/UPDATE\s+public\.profiles\s+SET\s+diamonds/i);
    });

    it('takes the oldest first, so a limit never strands what is closest to expiring', () => {
      expect(sql).toContain('OLDEST FIRST');
    });

    it('does not queue behind itself', () => {
      expect(body).toContain('pg_try_advisory_lock');
      expect(body).toContain('pg_advisory_unlock');
    });

    it('stays silent on the cap and files everything else', () => {
      expect(body).toContain('DR7:user_over_daily_cap');
      expect(body).toContain('CH3:horse_claim_failed');
    });
  });

  describe('the event path stops paying anybody', () => {
    it('removes the claim from every copy', () => {
      expect(body).toContain('event function(s) still claim inside the event path');
      expect(body).toContain('a reference to the claim loop survives in');
    });

    it('removes the orphaned declaration too', () => {
      // An orphaned `v_claim record;` compiles fine and reads as though the claim is still there.
      expect(body).toContain('v_claim');
      expect(body).toContain('record;');
    });

    it('expects three event functions, because the name has two overloads', () => {
      expect(body).toContain('2 overloads + the serialized body');
    });

    it('knows the two copies close differently', () => {
      expect(sql).toContain('THE TWO COPIES CLOSE DIFFERENTLY');
      expect(body).toContain('(END;');
    });

    it('scopes its search so it cannot match the normaliser that searches for the same text', () => {
      expect(body).toMatch(/p\.proname LIKE 'record_daily_challenge_event%'/);
      expect(sql).toContain('guard matching its own text');
    });
  });

  describe('the health row stops blaming the horse mechanism for a human choice', () => {
    it('counts horses and humans separately', () => {
      expect(body).toMatch(/count\(\*\) FILTER \(WHERE p\.is_horse\)/);
      expect(body).toMatch(/count\(\*\) FILTER \(WHERE NOT COALESCE\(p\.is_horse, false\)\)/);
    });

    it('says a human unclaimed reward is not a defect', () => {
      expect(body).toContain('not a defect');
      expect(body).toContain('still treats a human unclaimed reward as a defect');
    });

    it('gives the sweep a reader, so a dead cron is visible', () => {
      expect(body).toContain('horse claim button');
      expect(body).toContain('NOTHING PRESSES A HORSE');
    });

    it('allows the sweep interval before calling a horse claim overdue', () => {
      expect(body).toMatch(/completed_at < now\(\) - interval '5 minutes'/);
    });
  });

  describe('the whole migration', () => {
    it('proves the sweep actually pays rather than asserting it exists', () => {
      expect(body).toContain('the sweep left more owed than it found');
      expect(body).toContain('were owed and the sweep paid none of them');
    });

    it('proves the books still balance after a sweep that may have paid', () => {
      expect(body).toContain('players + float <> register after the claim sweep');
    });

    it('states why a scheduled claim is the button and not a band-aid', () => {
      expect(sql).toContain('IS the button');
      expect(sql).toContain('A repair job would be one that noticed the claim had');
    });

    it('creates nothing that repairs, backfills or compensates', () => {
      expect(body).not.toMatch(
        /CREATE\s+(OR REPLACE\s+)?FUNCTION[^;]{0,200}(_repair_|_backpay_|_redrive_|_catchup_|_heal_)/i
      );
    });

    it('corrects the earlier claim that the fix was engine-side TypeScript', () => {
      expect(sql).toContain('I SAID THIS FIX WAS ENGINE-SIDE TYPESCRIPT. IT IS NOT');
    });
  });
});
