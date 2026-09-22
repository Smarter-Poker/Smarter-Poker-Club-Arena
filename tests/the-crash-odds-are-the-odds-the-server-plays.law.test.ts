/**
 * Diamond Crash fairness audit, 2026-09-22.
 *
 * WHY THIS EXISTS
 *
 * The game was found fair - sixteen of sixteen production rounds recompute
 * from their revealed seeds, no mismatch - and the lobby was found lying about
 * it. "Instant Crash 1 In 5" was typed into src/pages/DiamondGamesPage.tsx when
 * a crash paid nothing. Migration 20260919034436 made every round fund a
 * guaranteed minimum L out of its own odds - a tenth of the stake on an
 * ordinary wheel award, half on a Super one - so the crash point became
 * X = L + (0.8 - L) / u and an instant crash went from 1 in 4.8 to 1 in 4.3,
 * and to 1 in 2.4 on a Super award. Nobody moved the copy. "Up To 100x Per
 * Round" was the configured ceiling rather than anything the server promises:
 * a round's cap comes from its wheel award, 20x to 100x in practice. Three
 * source comments still described the no-minimum game, and the browser's
 * verifier defaulted the bet to 1 and the minimum to 0, so a third party
 * following its defaults disagreed with four of six award rounds.
 *
 * WHAT THIS PINS
 *  1. Every crash figure the lobby prints is computed from the server's own
 *     rules (the odds from fn_diamond_bonus_minimum's mirror, the cap from the
 *     bets the server quotes), never typed and never taken from the ceiling.
 *  2. The crash verifier takes the round's bet and minimum as required inputs,
 *     and every caller passes both.
 *  3. A live crash round and a game ticket are sealed in the database
 *     (migration 20260922173914, the Donkey Cross lock one table over), the
 *     settlement columns fn_crash_decide writes are the only ones that may
 *     move on a round still open, and the isolated fixture executes the probe
 *     that proves it.
 *  4. The owner console quotes the one setting each choice game deals
 *     (migration 20260922173916, fn_choice_mode), never a retired ladder.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** Source without comments: history may be explained, never counted as code. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const LOBBY = 'src/pages/DiamondGamesPage.tsx';
const FAIRNESS = 'src/utils/diamondGamesFairness.ts';
const SERVICE = 'src/services/DiamondGamesService.ts';
const LOCK =
  'supabase/migrations/20260922173914_a_live_crash_round_is_sealed_like_every_other_round.sql';
const QUOTE =
  'supabase/migrations/20260922173916_the_owner_console_quotes_the_mines_and_road_that_are_dealt.sql';
const RUNNER = 'scripts/dev/test-accounting-delivery.sh';
/** The columns fn_crash_decide writes as a round settles, and the only ones the lock lets move. */
const SETTLEMENT = [
  'status',
  'settled_at',
  'settled_by',
  'elapsed_ms',
  'cashout_cents',
  'payout_chips',
  'pool_chips_minted_after',
  'pool_chips_paid_after',
  'member_chips_after',
];

const migrations = () =>
  readdirSync(join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
/** The last migration that defines this function: what the database actually runs. */
const installed = (fn: string) => {
  const files = migrations()
    .filter((f) => read(`supabase/migrations/${f}`).includes(`FUNCTION public.${fn}(`))
    .sort();
  expect(files.length, `${fn} is defined by a migration`).toBeGreaterThan(0);
  const sql = read(`supabase/migrations/${files[files.length - 1]}`);
  const from = sql.indexOf(`FUNCTION public.${fn}(`);
  return sql.slice(from, sql.indexOf('$function$;', from));
};

describe('the crash odds are the odds the server plays', () => {
  it('the lobby computes its crash odds instead of printing a figure', () => {
    const src = code(LOBBY);
    expect(src).toContain("from '../utils/diamondGamesFairness'");
    expect(src).toMatch(/awardInstantCrashChances\(1,/);
    expect(src).toMatch(/awardInstantCrashChances\(2,/);
    expect(src).toMatch(/oneInRangeLabel\(/);
    // No odds typed into the page: "1 In 5" was true only before the minimum.
    expect(src).not.toMatch(/1 In \d/);
    // The odds belong to an award kind, and the page says which.
    expect(src).toMatch(/Ordinary Award/);
    expect(src).toMatch(/Super Award/);
  });

  it('the lobby quotes the cap the server quotes, never the configured ceiling', () => {
    const src = code(LOBBY);
    expect(src).toMatch(/crash\?\.bets/);
    expect(src).toMatch(/b\.cap_cents/);
    expect(src).not.toMatch(/crash\?\.config\?\.max_multiplier_cents/);
    // A figure with nothing behind it is not shown at all.
    expect(src).toMatch(/crashTop === null \? null :/);
  });

  it('the crash verifier is given the round, not a default', () => {
    const src = read(FAIRNESS);
    const input = src.slice(
      src.indexOf('export interface CrashFairnessInput'),
      src.indexOf('export interface CrashFairnessVerdict')
    );
    expect(input).toMatch(/\n {2}betChips: number;/);
    expect(input).toMatch(/\n {2}minimumPayoutChips: number;/);
    expect(input).not.toMatch(/betChips\?:/);
    expect(input).not.toMatch(/minimumPayoutChips\?:/);
    const point = src.slice(
      src.indexOf('export function crashPointCentsFromRoll'),
      src.indexOf('export function crashMultiplierCents')
    );
    expect(point).not.toMatch(/betChips\s*=/);
    expect(point).not.toMatch(/minimumPayoutChips\s*=/);
    expect(point).toContain('A Crash Round Is Checked With Its Bet And Its Minimum');
    // Every caller hands it both.
    const pages = readdirSync(join(ROOT, 'src/pages'), { withFileTypes: true })
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) => `src/pages/${e.name}`);
    for (const file of pages) {
      const caller = read(file);
      if (!caller.includes('verifyCrashRound(') && !caller.includes('crashPointCentsFromRoll('))
        continue;
      for (const call of caller.matchAll(/verifyCrashRound\(\{([\s\S]*?)\}\)/g)) {
        expect(call[1], file).toContain('betChips');
        expect(call[1], file).toContain('minimumPayoutChips');
      }
      for (const call of caller.matchAll(/crashPointCentsFromRoll\(((?:[^()]|\([^()]*\))*)\)/g))
        expect(call[1].split(',').length, `${file}: ${call[0]}`).toBe(3);
    }
  });

  it('the comments describe the game as it is dealt now', () => {
    const fairness = read(FAIRNESS);
    // The header carries the minimum and the migration that introduced it.
    expect(fairness).toContain('20260919034436');
    expect(fairness).toMatch(/L = minimum_payout_chips \/ bet_chips/);
    expect(fairness).toMatch(/P\(X >= x\) = \(0\.8 - L\) \/ \(x - L\)/);
    // The no-minimum formulas survive only as the case they are still true for.
    const stale = fairness.slice(0, fairness.indexOf('*/'));
    expect(stale).toMatch(/Only rounds sealed\n \* before that migration have L = 0/);
    const service = read(SERVICE);
    expect(service).not.toMatch(/a crash pays nothing/i);
    expect(service).toContain('20260919034436');
  });

  it('a live crash round and a game ticket are sealed in the database', () => {
    const body = installed('fn_diamond_game_append_only');
    // The maintenance escape and the minimum rule are exactly what they were.
    expect(body).toContain(
      "IF NULLIF(current_setting('app.ledger_maintenance', true), '') IS NOT NULL THEN"
    );
    expect(body).toContain('The Bonus Minimum Is Fixed When The Round Starts');
    // A round still open moves its settlement columns, and nothing else.
    expect(body).toMatch(/NEW\.status IN \('cashed', 'crashed'\)/);
    for (const column of SETTLEMENT)
      expect(body.match(new RegExp(`'${column}'`, 'g'))?.length, column).toBe(2);
    expect(body).toMatch(/\(to_jsonb\(NEW\) - ARRAY\[/);
    expect(body).toContain('A Sealed Crash Round Cannot Be Rewritten');
    // A ticket is spent once, and swept only after it expires unused.
    expect(body).toMatch(/OLD\.consumed_by IS NULL AND NEW\.consumed_by IS NOT NULL/);
    expect(body).toMatch(
      /\(to_jsonb\(NEW\) - 'consumed_by'\) = \(to_jsonb\(OLD\) - 'consumed_by'\)/
    );
    expect(body).toMatch(/OLD\.consumed_by IS NULL AND OLD\.expires_at < now\(\)/);
    expect(body).toContain('A Sealed Game Ticket Cannot Be Rewritten');
    // A settled round, and every delete, stay refused.
    expect(body).toContain(
      'is append-only: a settled round is a fact and is never edited or deleted'
    );
    const sql = read(LOCK);
    expect(sql).toContain(
      'CREATE TRIGGER trg_diamond_game_commits_sealed BEFORE DELETE OR UPDATE ON public.diamond_game_commits'
    );
    // It asserts what it replaces before it replaces it.
    expect(sql).toContain('ddfbed658ff1b4b6395ba11bd91c51ba');
  });

  it('no later migration unseals either table', () => {
    for (const file of migrations().filter((f) => f > '20260922173914_')) {
      const sql = read(`supabase/migrations/${file}`);
      expect(sql, file).not.toMatch(/DROP TRIGGER[^;]*trg_crash_rounds_append_only/i);
      expect(sql, file).not.toMatch(/DROP TRIGGER[^;]*trg_diamond_game_commits_sealed/i);
    }
  });

  it('the isolated fixture executes the probe that proves the lock', () => {
    const runner = read(RUNNER);
    const migration = runner.indexOf('20260922173914_a_live_crash_round_is_sealed');
    const probe = runner.indexOf('run_game_probe diamond-crash-round-is-sealed');
    expect(migration, `${RUNNER} loads the lock`).toBeGreaterThan(0);
    expect(probe, `${RUNNER} runs the probe`).toBeGreaterThan(migration);
    // The real settlement and award-start paths run again on top of the lock.
    expect(
      runner.indexOf('run_game_probe diamond-crash-clicked-multiplier', migration)
    ).toBeGreaterThan(migration);
    expect(
      runner.indexOf('run_game_probe diamond-one-setting-super-guarantee', migration)
    ).toBeGreaterThan(migration);
    const sealed = read('tests/sql/diamond-crash-round-is-sealed.sql');
    expect(sealed).toContain('A Sealed Crash Round Cannot Be Rewritten');
    expect(sealed).toContain('A Sealed Game Ticket Cannot Be Rewritten');
  });

  it('the owner console quotes the setting each game actually deals', () => {
    const body = installed('fn_diamond_game_quote_max');
    expect(body).toContain('public.fn_choice_mode(p_game)');
    expect(body).not.toMatch(/ARRAY\['5','10','15'\]/);
    expect(body).not.toMatch(/ARRAY\['steady','bold','extreme'\]/);
    expect(read(QUOTE)).toContain('c5777bdd093188bae790db9758480411');
  });
});
