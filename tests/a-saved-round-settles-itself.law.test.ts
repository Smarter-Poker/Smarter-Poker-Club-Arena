/**
 * Owner ruling, 2026-09-21: "NO GAMES SHOULD EVER REQUIRE A USER TO CHECK
 * ANYTHING, THEY MUST ALWAYS AUTO START AND PLAY."
 *
 * WHY THIS EXISTS
 *
 * Donkey Cross, Shark Club, 18:46 UTC. The player pressed Start Round and the
 * server answered 409 seven times: the sealed ticket the page held had been
 * deleted by the server the moment the page asked for a second one, and the
 * start function hit that as a foreign-key exception before admission could
 * refuse it cleanly. The page did what it was built to do with an answer it
 * could not read - it saved the wager and printed "Check Your Saved Round
 * Before Starting Another" - and the bonus guard held every exit. A control
 * that replays a saved wager is fine; a control the player MUST press to get
 * their game back is the bug.
 *
 * This law pins the whole class, not the one message:
 *  1. No Diamond Spins game surface tells the player to check, refresh, retry
 *     or recover anything. Every such state recovers by itself.
 *  2. Every page that saves a wager replays it on its own schedule
 *     (useAutoSettle) and reads the ticket-gone refusal, so a refused ticket is
 *     re-dealt and the wager sent again without a press.
 *  3. The server never deletes a player's live ticket when dealing another,
 *     and both start functions refuse a dead ticket before the entry whose
 *     foreign key would turn it into an exception. Pinned by the installed
 *     migration text, so a later rewrite of either function must carry the
 *     same guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments: history may be explained, never shown. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/** The four Diamond Spins games a player can be sent to by the wheel. */
const GAME_PAGES = [
  'src/pages/DiamondChoicePage.tsx',
  'src/pages/DiamondPlinkoPage.tsx',
  'src/pages/DiamondCrashPage.tsx',
  'src/pages/DiamondWheelPage.tsx',
];
/** The games a wheel award opens. */
const AWARD_PAGES = GAME_PAGES.filter((p) => !p.endsWith('DiamondWheelPage.tsx'));
/** Shared pieces every one of those pages renders or reads. */
const SHARED = ['src/hooks/useEarnedBonus.ts', 'src/components/games/BonusSetup.tsx'];

/** Copy that hands recovery to the player. Each was on a game page before
 * this law; each state now recovers by itself. */
const TELLS_THE_PLAYER_TO_RECOVER = [
  /['"`>]\s*Check (Round|Bonus|Your)/,
  /Before Starting Another/,
  /Could Not Be Checked/,
  /['"`]Recover Spin['"`]/,
  /Retry To Recover/,
];

const MIGRATION =
  'supabase/migrations/20260921185541_a_saved_round_settles_itself_and_a_ticket_is_never_pulled_from_under_a_live_page.sql';

describe('a saved round settles itself', () => {
  it('every page that saves a wager is on the list', () => {
    const saving = readdirSync(join(ROOT, 'src/pages'))
      .filter((f) => /\.tsx$/.test(f))
      .filter((f) => read(`src/pages/${f}`).includes('pendingBonus('))
      .map((f) => `src/pages/${f}`);
    expect(saving.sort()).toEqual([...AWARD_PAGES].sort());
  });

  it.each([...GAME_PAGES, ...SHARED])('%s never asks the player to check or recover a round', (file) => {
    const src = code(file);
    for (const phrase of TELLS_THE_PLAYER_TO_RECOVER) expect(src).not.toMatch(phrase);
  });

  it.each(AWARD_PAGES)('%s replays a saved wager on its own schedule', (file) => {
    const src = read(file);
    expect(src).toContain("from '../hooks/useAutoSettle'");
    expect(src).toMatch(/useAutoSettle\(/);
    // A ticket the server refused is re-dealt and the wager sent again.
    expect(src).toContain('ticketGone');
    // Another tab's saved wager settles first, by itself.
    expect(src).toContain('PriorBonusPending');
  });

  it('the wheel recovers an unconfirmed spin by itself', () => {
    const src = read('src/pages/DiamondWheelPage.tsx');
    expect(src).toContain("from '../hooks/useAutoSettle'");
    expect(src).toMatch(/useAutoSettle\(/);
  });

  it('the bonus service surfaces the ticket-gone refusal', () => {
    const src = read('src/services/DiamondBonusService.ts');
    expect(src).toContain("result.ticket === 'gone'");
    expect(src).toMatch(/readonly ticketGone/);
  });

  it('a saved wager that cannot be replayed is discarded, never thrown', () => {
    const src = read('src/services/diamondBonusRecovery.ts');
    expect(src).not.toContain("throw new Error('The Saved Bonus Needs To Be Checked')");
    expect(src).toContain('class PriorBonusPending');
  });

  it('a failed award read retries itself', () => {
    const src = read('src/hooks/useEarnedBonus.ts');
    expect(src).toMatch(/useAutoSettle\(/);
  });

  it('the server keeps live tickets and refuses a dead one before any entry', () => {
    const sql = read(MIGRATION);
    // Dealing a ticket sweeps only this player's EXPIRED unconsumed tickets.
    expect(sql).toContain(
      'DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();'
    );
    expect(sql).not.toContain(
      'DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;'
    );
    // The refusal holds the ticket row until the entry that references it is written.
    expect(sql).toMatch(/WHERE id = p_commit_id FOR KEY SHARE;/);
    // Both start functions ask the ticket refusal before their INSERT.
    for (const fn of ['fn_diamond_bonus_start', 'fn_wheel_bonus_start']) {
      const body = sql.slice(sql.indexOf(`FUNCTION public.${fn}(`));
      const refusal = body.indexOf('public.fn_diamond_ticket_refusal(');
      const insert = body.indexOf('INSERT INTO public.diamond_bonus_entries');
      expect(refusal, `${fn} refuses a dead ticket`).toBeGreaterThan(0);
      expect(refusal, `${fn} refuses before it inserts`).toBeLessThan(insert);
    }
    expect(sql).toContain("'ticket', 'gone'");
  });

  it('no later migration reinstates the live-ticket sweep', () => {
    const later = readdirSync(join(ROOT, 'supabase/migrations'))
      .filter((f) => f > '20260921185541_' && f.endsWith('.sql'))
      .map((f) => read(`supabase/migrations/${f}`));
    for (const sql of later) {
      expect(sql).not.toMatch(
        /DELETE FROM public\.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;/
      );
    }
  });
});
