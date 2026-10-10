/**
 * THE FIVE LAUNCH OWNER DECISIONS (2026-10-07), decided under CLAUDE.md 10.9
 * on Dan's delegation. docs/changelog/2026-10-07-five-launch-owner-decisions.md.
 *
 *   1. Insurance is not sold on a hi-lo game: the engine never offers it and
 *      the create flow shows no switch for it.
 *   2. A promotion advertises no prize money, because nothing pays one.
 *   3. Every paid finish of a scheduled event is told to its player, horse or
 *      human, in the payment's own transaction.
 *   4. Only a club's owner may write its club card image.
 *   5. A Diamond jackpot hit pays every Diamond it announces; the floors'
 *      leftover goes to the losing hand, as in chips.
 *
 * Each decision is behaviour that a later edit could quietly undo, so each is
 * pinned at the line that carries it. The SQL is read with comments stripped,
 * because the headers discuss the strings the assertions look for.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const stripSql = (s: string) => s.replace(/--[^\n]*/g, '');

const decisions = stripSql(
  read('supabase/migrations/20261007014946_five_launch_owner_decisions.sql')
);
const jackpot = stripSql(
  read(
    'supabase/migrations/20261007015026_a_diamond_jackpot_hit_pays_every_diamond_it_announces.sql'
  )
);

describe('1. insurance is not sold on a hi-lo game', () => {
  it('the engine gate refuses a hi-lo hand by the hand variant', () => {
    const runout = read('server/src/engine/ServerTableEngineRunout.ts');
    expect(runout).toMatch(/if \(isHiLoVariant\(controller\.getGameVariant\(\)\)\) return false;/);
    expect(runout).toContain(
      'const insuranceEnabled = insuranceOnThisHand && insuranceContractIsExact(this.handController);'
    );
  });

  it('the create flow shows no Insurance switch on a hi-lo game and sends it off', () => {
    const flow = read('src/components/cash/CashGameCreateFlow.tsx');
    expect(flow).toContain('const insuranceOffered = !isEightOrBetterVariant(variant);');
    expect(flow).toMatch(/\{insuranceOffered && \(\s*<Toggle\s+label="Insurance"/);
    expect(flow).toContain('insurance_enabled: false');
  });
});

describe('2. a promotion advertises no prize money', () => {
  it('a CHECK refuses a prize pool and the reporting trigger is gone', () => {
    expect(decisions).toMatch(
      /ADD CONSTRAINT promotions_advertise_no_unpaid_prize\s+CHECK \(COALESCE\(prize_pool, 0\) = 0\)/
    );
    expect(decisions).toContain(
      'DROP TRIGGER IF EXISTS trg_promotion_prize_has_no_payout_path ON public.promotions;'
    );
  });
});

describe('3. a paid finish of a scheduled event is told', () => {
  it('the notice is written by the payment itself, for scheduled events', () => {
    expect(decisions).toMatch(
      /CREATE TRIGGER trg_tournament_payout_tells_the_player\s+AFTER INSERT ON public\.tournament_payouts/
    );
    expect(decisions).toContain("NOT IN ('MTT', 'SATELLITE')");
    expect(decisions).toContain("'tournament_result'");
  });

  it('a horse is told on the same terms (CLAUDE.md 10.5) and a notice never blocks a payment', () => {
    const body = decisions.slice(
      decisions.indexOf('fn_tournament_payout_tells_the_player()'),
      decisions.indexOf('CREATE TRIGGER trg_tournament_payout_tells_the_player')
    );
    expect(body).not.toMatch(/is_horse/i);
    expect(body).toContain('EXCEPTION WHEN OTHERS THEN');
  });
});

describe("4. only a club's owner writes its club card", () => {
  it('both write policies ask the owner test, and the open ones are dropped', () => {
    expect(decisions).toContain(
      'DROP POLICY IF EXISTS "club cards authenticated insert" ON storage.objects;'
    );
    expect(decisions).toContain(
      'DROP POLICY IF EXISTS "club cards owner update" ON storage.objects;'
    );
    expect(decisions.match(/public\.fn_club_card_object_is_callers\(name\)/g)?.length).toBe(3);
    expect(decisions).toContain('WHERE c.owner_id = auth.uid()');
  });

  it('the home page only bakes a card for a club the viewer owns', () => {
    const home = read('src/pages/HomePage.tsx');
    expect(home).toMatch(/c\.is_owner === true &&\s+c\.entity_type !== 'union' &&/);
  });
});

describe('5. a Diamond jackpot hit pays every Diamond it announces', () => {
  it('the leftover goes to the losing hand and anything else is refused', () => {
    expect(jackpot).toContain('v_loser := v_loser + v_remainder;');
    expect(jackpot).toMatch(
      /IF v_paid_out <> v_paid THEN\s+RAISE EXCEPTION 'diamond_jackpot_paid_other_than_it_announced/
    );
    expect(jackpot).toContain("'24b540141853cc8c246cd4dfc121ebc4'");
  });

  it('the isolated acceptance case pays 105 of 105', () => {
    const acceptance = read('tests/sql/poker-diamond-bad-beat-jackpot-acceptance.sql');
    expect(acceptance).toContain(
      "(r->>'paid_out')::bigint = 105 AND (r->>'left_in_main_pool')::bigint = 0"
    );
    const runner = read('tests/sql/run-diamond-bad-beat-jackpot.py');
    expect(runner).toContain(
      "load(LEFTOVER_MIGRATION, 'the leftover rule, verbatim and unnarrowed')"
    );
  });
});
