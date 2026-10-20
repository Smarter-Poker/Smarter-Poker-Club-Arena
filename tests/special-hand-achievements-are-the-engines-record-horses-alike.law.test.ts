/**
 * Royal Flush, Straight Flush and Four Of A Kind are recorded from the
 * engine's own hand record, for every player, horses alike (2026-10-20).
 *
 * The browser used to report them: TablePage passed the winning hand's
 * display name ("Four of a Kind") and AchievementService.checkSpecialHand only
 * knew snake keys ("four_of_a_kind"), so none of them could unlock from play;
 * it read the first winner's hand, not this player's; and a horse has no
 * browser (CLAUDE.md 10.5: horses are players, identically). Migration
 * 20261020005219 reads hand_history.daily_mission_events strong_hands - the
 * engine's per-player strongest hand that won a pot - for 10, 9 and 8.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACHIEVEMENTS } from '../src/services/AchievementService';
import { dailyMissionHandStrength } from '../server/src/engine/dailyMissionEvents';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const MIGRATION =
  'supabase/migrations/20261020005219_straight_flush_and_quads_are_proved_from_the_engine_hand_rec.sql';
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
  it('maps 10 / 9 / 8 to royal_flush / straight_flush / quads, and nothing else', () => {
    expect(body).toMatch(
      /WHEN 10 THEN 'royal_flush'\s+WHEN 9\s+THEN 'straight_flush'\s+WHEN 8\s+THEN 'quads'\s+END AS achievement_id/
    );
    expect(body).toContain(
      "'$[*] ? (@.magnitudes.strong_hands >= 8 && @.magnitudes.strong_hands <= 10)'"
    );
    expect(body).toMatch(
      /CREATE TRIGGER trg_hand_history_winning_hand_achievements\s+AFTER INSERT ON public\.hand_history\s+FOR EACH ROW\s+WHEN \(NEW\.daily_mission_events IS NOT NULL\s+AND jsonb_path_exists\(NEW\.daily_mission_events, '\$\[\*\] \? \(@\.magnitudes\.strong_hands >= 8\)'\)\)/
    );
  });

  it('replaces the Royal Flush-only trigger in the same transaction, so no royal is read twice', () => {
    expect(body).toContain(
      'DROP TRIGGER trg_hand_history_royal_flush_achievement ON public.hand_history;'
    );
    expect(body).toContain('DROP FUNCTION public.tr_hand_history_royal_flush_achievement();');
    expect(body.indexOf('DROP TRIGGER')).toBeLessThan(body.indexOf('CREATE TRIGGER'));
    expect(body.trim().endsWith('COMMIT;')).toBe(true);
    expect(body).toContain("SET LOCAL lock_timeout = '5s';");
  });

  it('pays through the one server door, and can never fail the hand', () => {
    expect(body).toContain('PERFORM public.fn_achievement_unlock_server(');
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING '% achievement for/);
    expect(body).toMatch(/EXCEPTION WHEN OTHERS THEN\s+RAISE WARNING 'winning hand achievements/);
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
      '20261020005219_straight_flush_and_quads_are_proved_from_the_engine_hand_rec.sql'
    );
    expect(proof).toContain('psql(WINNING_HANDS.read_text())');
  });
});
