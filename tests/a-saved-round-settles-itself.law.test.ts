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
 *  3. A won game waits for the player (owner ruling 2026-09-21, R1 and R9,
 *     which supersedes the auto-start clause this law carried: "Games can
 *     NEVER auto start. Remove the countdown clock that triggers an auto
 *     start", and "the won game must stay on screen until the user selects
 *     Play Game"). No countdown presses Start; no page imports a hook that
 *     would. The bonus guard still holds a page for money in flight, and for a
 *     won game only while that game can actually start - never on an award the
 *     page cannot start, so waiting is never being trapped.
 *  4. The server never deletes a player's live ticket when dealing another,
 *     and both start functions refuse a dead ticket before the entry whose
 *     foreign key would turn it into an exception. Pinned by the installed
 *     migration text, so a later rewrite of either function must carry the
 *     same guard.
 *  5. Both start functions answer a ticket this request already used with its
 *     receipt BEFORE they can call the ticket gone (review finding 8,
 *     2026-09-22). Reversed, a replay of a start that committed would be
 *     answered "gone", and the page would deal a fresh ticket and send the
 *     wager again: a second charge.
 *  6. An error the database answered is an answer (review finding 2,
 *     2026-09-22). A SQLSTATE means that execution rolled back, so the service
 *     refuses it (a passing one after three sends of the same request) and the
 *     page lets the player go; only an error with no code keeps the wager
 *     replaying, and never from a background tab. A receipt the browser cannot
 *     verify stops after three and lets the player go, the wager kept for the
 *     next visit. A wager that could not be saved was never sent: a refusal.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BONUS_SENDS_PER_REQUEST, bonusErrorKind } from '../src/services/DiamondBonusService';
import { spinErrorKind } from '../src/services/DiamondWheelService';

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
  // A failed load, quote or ticket deal is tried again by the page itself.
  /Try Refresh/,
  /Refresh To (Try|Check)/,
  /Refresh The Wheel To Retry/,
  /Refresh After The Break/,
  /Refresh Or Return/,
  /Tap Retry/,
  /['"`>]\s*Retry (Game|Bonus Spins)/,
  /Retry Below/,
  /Try Again/,
  /onRetry=/,
  /onRefresh=/,
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

  it.each([...GAME_PAGES, ...SHARED])(
    '%s never asks the player to check or recover a round',
    (file) => {
      const src = code(file);
      for (const phrase of TELLS_THE_PLAYER_TO_RECOVER) expect(src).not.toMatch(phrase);
    }
  );

  it.each(AWARD_PAGES)('%s replays a saved wager on its own schedule', (file) => {
    const src = read(file);
    expect(src).toContain("from '../hooks/useAutoSettle'");
    expect(src).toMatch(/useAutoSettle\(/);
    // A ticket the server refused is re-dealt and the wager sent again.
    expect(src).toContain('ticketGone');
    // Another tab's saved wager settles first, by itself.
    expect(src).toContain('PriorBonusPending');
  });

  it.each(AWARD_PAGES)('%s never starts a won game by itself', (file) => {
    const src = read(file);
    // Owner ruling 2026-09-21, R1: the countdown that pressed Start is gone,
    // and nothing may put one back. Pinned on the source because a clock the
    // player never sees is exactly what a rendered test misses.
    expect(src).not.toContain('useAwardAutoStart');
    expect(src).not.toContain('useIdleSpinCountdown');
    expect(src).not.toMatch(/Starting In \$\{|Dropping In \$\{/);
  });

  it.each(AWARD_PAGES)('%s does not hold a player on a won game that cannot start', (file) => {
    const src = code(file);
    const from = src.indexOf('useLiveBonusGuard(');
    expect(from).toBeGreaterThan(-1);
    const guard = src.slice(from, src.indexOf(');', from));
    // The award term is always joined to "and it can start".
    expect(guard).toMatch(/Boolean\(earned\.award\)\s*&&/);
    expect(guard).not.toMatch(/Boolean\(earned\.award\)\s*\|\|/);
  });

  it.each(AWARD_PAGES)('%s re-sends the exact refused wager, never a rebuilt one', (file) => {
    // Review 2026-09-21: a restart rebuilt from the page could charge another
    // award's Double Down, or drop the saved auto cash-out.
    const src = code(file);
    expect(src).toMatch(/owed\.current = refused;/);
    expect(src).toMatch(/Ref\.current\(wager\)/);
  });

  it.each(AWARD_PAGES)('%s lets go of a won game the server refused', (file) => {
    const src = code(file);
    expect(src).toMatch(/useRefusedAward\(/);
    const from = src.indexOf('useLiveBonusGuard(');
    const guard = src.slice(from, src.indexOf(');', from));
    expect(guard).toMatch(/refusal\.refused/);
  });

  it('a saved wager is judged by its own game', () => {
    const src = code('src/services/diamondBonusRecovery.ts');
    expect(src).toMatch(
      /v\.game === 'plinko' && bonusTotal\(v\.budget\) % v\.budget\.denomination/
    );
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

  it('a saved wheel spin that cannot be read is discarded, never thrown', () => {
    // Thrown, it stranded the wheel on "Reconnecting" for good: the save lives in
    // localStorage and every load retry read it again.
    const src = read('src/utils/wheelPendingSpin.ts');
    const reader = src.slice(src.indexOf('export function readWheelPending('));
    const body = reader.slice(0, reader.indexOf('\n}\n'));
    expect(body).not.toMatch(/\bthrow\b/);
    expect(src).toContain('localStorage.removeItem(key)');
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

  it('both start functions answer a used ticket with its receipt before they can call it gone', () => {
    const sql = read(MIGRATION);
    /** One function's body, from its signature to its own end. */
    const body = (fn: string) => {
      const from = sql.indexOf(`FUNCTION public.${fn}(`);
      expect(from, `${fn} is defined`).toBeGreaterThan(0);
      return sql.slice(from, sql.indexOf('END $function$;', from));
    };
    for (const [fn, replay] of [
      [
        'fn_diamond_bonus_start',
        'SELECT * INTO prior FROM public.diamond_bonus_entries WHERE commit_id=p_commit_id;',
      ],
      ['fn_wheel_bonus_start', "IF a.status='redeemed' THEN"],
    ]) {
      const src = body(fn);
      const lock = src.indexOf('pg_advisory_xact_lock(hashtextextended(p_commit_id::text,94613))');
      const replayed = src.indexOf(replay);
      const receipt = src.indexOf("'replayed',true", replayed);
      const refusal = src.indexOf('public.fn_diamond_ticket_refusal(');
      expect(lock, `${fn} takes the ticket's lock first`).toBeGreaterThan(0);
      expect(replayed, `${fn} looks for the request's own round under that lock`).toBeGreaterThan(
        lock
      );
      expect(receipt, `${fn} answers that round with its receipt`).toBeGreaterThan(replayed);
      expect(refusal, `${fn} still refuses a dead ticket`).toBeGreaterThan(0);
      // Reversed, a replay would answer 'gone' and the page would send again.
      expect(receipt, `${fn} replays before it can call the ticket gone`).toBeLessThan(refusal);
    }
  });

  it('an error the database answered is an answer, never a wager resent for ever', () => {
    // One rule for the bonus games and the wheel.
    for (const code of [
      '23503',
      '23514',
      'P0001',
      '40001',
      '40P01',
      '55P03',
      '57014',
      'PGRST000',
      'PGRST003',
      'PGRST116',
      'PGRST301',
      '',
    ])
      expect(bonusErrorKind({ code }), code).toBe(spinErrorKind({ code }));
    expect(bonusErrorKind({ code: '23503' })).toBe('refused');
    expect(bonusErrorKind({ code: '40001' })).toBe('transient');
    expect(bonusErrorKind({ code: 'PGRST002' })).toBe('transient');
    expect(bonusErrorKind({ code: 'PGRST301' })).toBe('refused');
    expect(bonusErrorKind({ code: '' })).toBe('unknown');
    expect(bonusErrorKind(new Error('Connection Lost'))).toBe('unknown');
    expect(BONUS_SENDS_PER_REQUEST).toBe(3);
    const service = code('src/services/DiamondBonusService.ts');
    const start = service.slice(service.indexOf('async start('), service.indexOf('async latest('));
    // The start door classifies its error; it never rethrows every one.
    expect(start).not.toMatch(/if \(error\) throw error;/);
    expect(start).toMatch(/bonusErrorKind\(error\)/);
    expect(start).toMatch(/throw new BonusRefusal\(BONUS_NOT_TAKEN\)/);
    // A receipt that will not verify is its own answer, kept, counted, final.
    expect(start).toMatch(/throw new BonusUnreadable\(/);
    // A wager that could not be saved was never sent: a refusal.
    expect(start).toMatch(/throw new BonusRefusal\(BONUS_NOT_SAVED\)/);
    for (const page of AWARD_PAGES) {
      const src = code(page);
      // The page stops on the third unreadable answer and lets the player go.
      expect(src, page).toMatch(/instanceof BonusUnreadable && \w+\.final/);
      expect(src, page).toMatch(/useAutoSettle\(\s*uncertain && !saved/);
      const from = src.indexOf('useLiveBonusGuard(');
      expect(src.slice(from, src.indexOf(');', from)), page).toMatch(/!saved &&/);
    }
    // A background tab replays nothing.
    expect(code('src/hooks/useAutoSettle.ts')).toMatch(/document\.hidden/);
    // Crash replays nothing behind its load-error screen, where the guard is off.
    expect(code('src/pages/DiamondCrashPage.tsx')).toMatch(
      /uncertain && !saved && !loading && !loadError && Boolean\(state\)/
    );
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
