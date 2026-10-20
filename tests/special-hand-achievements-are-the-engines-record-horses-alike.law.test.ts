/**
 * Royal Flush, Straight Flush and Four Of A Kind are recorded from the
 * engine's own hand record, for every player, horses alike (2026-10-20).
 *
 * The browser used to report them: TablePage passed the winning hand's
 * display name ("Four of a Kind") and AchievementService.checkSpecialHand only
 * knew snake keys ("four_of_a_kind"), so none of them could unlock from play;
 * it read the first winner's hand, not this player's; and a horse has no
 * browser (CLAUDE.md 10.5: horses are players, identically). The Royal Flush
 * trigger (20261019155445) reads hand_history.daily_mission_events
 * strong_hands = 10 - the engine's per-player strongest hand that won a pot -
 * and migration 20261020022215 adds one beside it for 9 and 8.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACHIEVEMENTS } from '../src/services/AchievementService';
import { dailyMissionHandStrength } from '../server/src/engine/dailyMissionEvents';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const MIGRATION =
  'supabase/migrations/20261020022215_straight_flush_and_quads_get_their_own_hand_trigger.sql';
const sql = read(MIGRATION);
const body = sql.slice(sql.indexOf('\nBEGIN;\n'));

describe('the engine names every special hand the badges name', () => {
  // Every name PokerEngine.evaluate5Cards emits, as written there, and the
  // Title Case a display layer would turn it into.
  const names: Array<[string, number]> = [
    ['Royal Flush', 10],
    ['Straight Flush', 9],
    ['Four of a Kind', 8],
    ['Four Of A Kind', 8],
    ['Full House', 7],
    ['Flush', 6],
    ['Straight', 5],
    ['Three of a Kind', 4],
    ['Two Pair', 3],
    ['Pair', 2],
    ['High Card', 1],
  ];
  it.each(names)('%s is strength %i', (name, strength) => {
    expect(dailyMissionHandStrength({ name })).toBe(strength);
  });

  it('the engine evaluator still emits exactly these names', () => {
    const engine = read('server/src/engine/PokerEngine.ts');
    for (const name of ['Royal Flush', 'Straight Flush', 'Four of a Kind']) {
      expect(engine).toContain(`name: '${name}'`);
    }
  });
});

describe('the database records them, horses alike', () => {
  it('maps 9 / 8 to straight_flush / quads and leaves 10 to the Royal Flush trigger', () => {
    expect(body).toMatch(
      /CASE \(e #>> '\{magnitudes,strong_hands\}'\)::numeric\s+WHEN 9 THEN 'straight_flush'\s+WHEN 8 THEN 'quads'\s+END AS achievement_id/
    );
    expect(body).toContain(
      "'$[*] ? (@.magnitudes.strong_hands == 9 || @.magnitudes.strong_hands == 8)'"
    );
    expect(body).toMatch(
      /CREATE TRIGGER trg_hand_history_straight_flush_quads_achievements\s+AFTER INSERT ON public\.hand_history\s+FOR EACH ROW\s+WHEN \(NEW\.daily_mission_events IS NOT NULL\s+AND jsonb_path_exists\(NEW\.daily_mission_events,\s+'\$\[\*\] \? \(@\.magnitudes\.strong_hands == 9 \|\| @\.magnitudes\.strong_hands == 8\)'\)\)/
    );
    expect(body).not.toMatch(/WHEN 10 THEN|@\.magnitudes\.strong_hands == 10|strong_hands >= /);
  });

  it('never drops anything on hand_history: only a CREATE TRIGGER, which readers do not block', () => {
    // 20261020005219 dropped the Royal Flush trigger in the same transaction;
    // DROP TRIGGER needs ACCESS EXCLUSIVE, waited behind readers and was
    // refused by lock_timeout (nothing committed). It is superseded.
    expect(body).not.toMatch(/DROP TRIGGER|DROP FUNCTION|ALTER TABLE public\.hand_history/);
    expect(body.trim().endsWith('COMMIT;')).toBe(true);
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
    expect(
      read(
        'supabase/migrations/20261020005219_straight_flush_and_quads_are_proved_from_the_engine_hand_rec.sql'
      ).startsWith('-- SUPERSEDED BY 20261020022215:')
    ).toBe(true);
  });

  it('records through the one server door, and can never fail the hand', () => {
    expect(body).toContain('PERFORM public.fn_achievement_unlock_server(');
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING '% achievement for/);
    expect(body).toMatch(
      /EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'straight flush \/ quads achievements/
    );
    expect(body).not.toMatch(/award_diamonds_v2\(|diamond_transactions|INSERT INTO/i);
  });

  it('horses are players: nothing here branches on is_horse (CLAUDE.md 10.5)', () => {
    expect(body).not.toMatch(/is_horse/i);
    expect(body).toContain('horses included');
  });

  it('the rewards do not change: Straight Flush and quads stay zero-reward badges', () => {
    expect(body).toContain(
      "SET evidence = 'engine_winning_hand'\n WHERE id IN ('quads', 'straight_flush');"
    );
    expect(body).not.toMatch(/SET\s+reward_diamonds/i);
  });
});

describe('the browser does not report them', () => {
  it('all three special hands are server-proved in the client catalog', () => {
    for (const id of ['royal_flush', 'straight_flush', 'quads']) {
      expect(ACHIEVEMENTS.find((a) => a.id === id)?.serverProved, id).toBe(true);
    }
  });

  it('the table no longer hands a winner name to achievements', () => {
    const service = read('src/services/AchievementService.ts');
    const trigger = read('src/services/AchievementTriggerService.ts');
    const table = read('src/pages/TablePage.tsx');
    expect(service).not.toMatch(/async checkSpecialHand\(/);
    expect(trigger).not.toMatch(/checkSpecialHand\(|handRank/);
    expect(table).not.toMatch(/handRank: outcome\.handRank/);
  });

  it('the native PostgreSQL proof applies this migration byte for byte', () => {
    const proof = read('scripts/ci/test-achievement-diamonds-postgres.py');
    expect(proof).toContain(
      '20261020022215_straight_flush_and_quads_get_their_own_hand_trigger.sql'
    );
    expect(proof).toContain('psql(WINNING_HANDS.read_text())');
  });
});
