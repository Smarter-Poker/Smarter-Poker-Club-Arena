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
 * This law pins three things:
 *  1. No Diamond Spins page prints a "Check ..." instruction or a "Check Round"
 *     / "Check Bonus" control. A saved wager is replayed by useAutoSettle.
 *  2. Every page that saves a wager (imports pendingBonus) mounts useAutoSettle
 *     and reads the ticket-gone refusal, so a refused ticket is re-dealt and the
 *     wager sent again without a press.
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

const GAME_PAGES = readdirSync(join(ROOT, 'src/pages')).filter((f) => /^Diamond.*Page\.tsx$/.test(f));
const SAVING_PAGES = GAME_PAGES.filter((f) => read(`src/pages/${f}`).includes('pendingBonus('));

const MIGRATION =
  'supabase/migrations/20260921185541_a_saved_round_settles_itself_and_a_ticket_is_never_pulled_from_under_a_live_page.sql';

describe('a saved round settles itself', () => {
  it('finds the pages that save a wager', () => {
    expect(SAVING_PAGES.sort()).toEqual(
      ['DiamondChoicePage.tsx', 'DiamondCrashPage.tsx', 'DiamondPlinkoPage.tsx'].sort()
    );
  });

  it.each(GAME_PAGES)('%s never asks the player to check anything', (file) => {
    const src = read(`src/pages/${file}`);
    // Copy, labels and pills. "Check" as an instruction to the player is the
    // whole class; a comment may still explain history.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/['"`]Check (Round|Bonus|Your)/);
    expect(code).not.toMatch(/Could Not Be Checked\. Try Again/);
  });

  it.each(SAVING_PAGES)('%s replays a saved wager on its own schedule', (file) => {
    const src = read(`src/pages/${file}`);
    expect(src).toContain("from '../hooks/useAutoSettle'");
    expect(src).toMatch(/useAutoSettle\(/);
    // A ticket the server refused is re-dealt and the wager sent again.
    expect(src).toContain('ticketGone');
    expect(src).toContain('PriorBonusPending');
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

  it('the server keeps live tickets and refuses a dead one before any entry', () => {
    const sql = read(MIGRATION);
    // Dealing a ticket sweeps only this player's EXPIRED unconsumed tickets.
    expect(sql).toContain(
      'DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();'
    );
    expect(sql).not.toContain(
      'DELETE FROM public.diamond_game_commits WHERE user_id = v_user AND game = p_game AND consumed_by IS NULL;'
    );
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
