/**
 * THE PLAYER CAN SEE THE DAY, AND THE WAY OUT (2026-09-11, BINDING)
 *
 * Phase 4 of 6. Two things the three games never told a player.
 *
 * WHAT THE DAY WAS COSTING THEM. Every host sets a per-player daily ceiling,
 * 200 on both live hosts, and at 100 diamonds a spin that is 20,000 diamonds a
 * day per player per host. The wheel printed the COUNT against its ceiling in a
 * bay; Plinko and Crash printed nothing and refused at the wall; and not one of
 * the three ever showed a player what they had actually spent.
 *
 * AND THE WAY OUT. "Not Enough Diamonds For That Bet" was a dead end on all
 * three: the plate sat disabled saying the player was short, and offered
 * nothing. It is the ONE blocker a player can do something about, and the plate
 * they were already reaching for is now the door to the store.
 *
 * The platform's own helper was worse. showDiamondTopUp has taken a `navigate`
 * since it was written and never called it, so the "universal" top-up path went
 * nowhere: the message named a store it could not open.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const ROOT = resolve(__dirname, '..');
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

/**
 * ONE READ OF THE CORPUS PER FILE, NOT ONE PER FUNCTION (2026-09-11).
 *
 * supabase/migrations holds 2,917 files and 32MB. inForce has to scan all of
 * them to find the last declaration of a function, and it was re-reading the
 * whole corpus for every distinct name, so a law asking about four functions
 * read 128MB. Under the full suite's parallelism that put this file and about
 * seventy-five other migration-scanning laws over vitest's 5 second budget:
 * every one of them a timeout, none of them an assertion failure, all of them
 * green when run alone. The contents are cached by filename instead.
 */
const fileCache = new Map<string, string>();
function read(f: string): string {
  const hit = fileCache.get(f);
  if (hit !== undefined) return hit;
  const sql = readFileSync(resolve(DIR, f), 'utf8');
  fileCache.set(f, sql);
  return sql;
}

const cache = new Map<string, { name: string; sql: string }>();
function inForce(fn: string): { name: string; sql: string } {
  const hit = cache.get(fn);
  if (hit) return hit;
  const hits = files
    .filter((f) => {
      const sql = read(f);
      return (
        sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}(`) ||
        sql.includes(`CREATE FUNCTION public.${fn}(`)
      );
    })
    .sort();
  expect(hits.length, `no migration declares ${fn}`).toBeGreaterThan(0);
  const name = hits[hits.length - 1];
  const found = { name, sql: read(name) };
  cache.set(fn, found);
  return found;
}
function body(sql: string, fn: string): string {
  const open = Math.max(
    sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`),
    sql.lastIndexOf(`CREATE FUNCTION public.${fn}(`)
  );
  expect(open, `${fn} has moved or gone`).toBeGreaterThan(-1);
  const start = sql.indexOf('$function$', open);
  const end = sql.indexOf('$function$', start + 10);
  return sql.slice(start, end);
}
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const SPENT = body(inForce('fn_diamond_games_spent_today').sql, 'fn_diamond_games_spent_today');
const PAGES = [
  'src/pages/DiamondWheelPage.tsx',
  'src/pages/DiamondPlinkoPage.tsx',
  'src/pages/DiamondCrashPage.tsx',
];

describe('the day is one figure, from one definition', () => {
  it('both state reads ask the same helper', () => {
    expect(body(inForce('fn_wheel_state').sql, 'fn_wheel_state')).toContain(
      'public.fn_diamond_games_spent_today(v_host, v_user)'
    );
    expect(body(inForce('fn_diamond_game_state').sql, 'fn_diamond_game_state')).toContain(
      'public.fn_diamond_games_spent_today(v_host, v_user)'
    );
  });

  it('it counts all three games, because a player has one wallet', () => {
    expect(SPENT).toContain('FROM public.wheel_spins s');
    expect(SPENT).toContain('FROM public.plinko_drops d');
    expect(SPENT).toContain('FROM public.crash_rounds c');
  });

  it('on the same day the caps are counted on, so both turn together', () => {
    expect(SPENT.match(/AT TIME ZONE 'America\/Chicago'\)::date/g)?.length).toBe(6);
    expect(body(inForce('fn_wheel_spin_core').sql, 'fn_wheel_spin_core')).toContain(
      "AT TIME ZONE 'America/Chicago')::date"
    );
  });

  it('a welcome spin costs nothing, so it counts for nothing', () => {
    expect(SPENT).toContain('NOT COALESCE(s.is_welcome, false)');
  });

  it('an OPEN crash round counts, which is the opposite of what the P and L does', () => {
    // Deliberate: the operator's profit is not real until the round decides,
    // and the player's money is gone the moment they bet it.
    expect(SPENT).not.toContain("c.status <> 'open'");
    expect(body(inForce('fn_diamond_game_pnl').sql, 'fn_diamond_game_pnl')).toContain(
      "c.status <> 'open'"
    );
  });

  it('no browser role may call it, and the per-player day is indexed', () => {
    const sql = inForce('fn_diamond_games_spent_today').sql;
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_diamond_games_spent_today(uuid, uuid) FROM authenticated;'
    );
    for (const ix of [
      'wheel_spins_host_user_time',
      'plinko_drops_host_user_time',
      'crash_rounds_host_user_time',
    ]) {
      expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${ix}`);
    }
  });
});

describe('one line, three pages', () => {
  it.each(PAGES)('%s shows the day from the shared component', (page) => {
    const s = src(page);
    expect(s).toContain("import TodayLine from '../components/games/TodayLine';");
    expect(s).toContain('spentDiamonds={player?.diamonds_today ?? 0}');
  });

  it('says the day once per screen, not twice', () => {
    // The wheel prints the count in a painted bay already.
    expect(src('src/pages/DiamondWheelPage.tsx')).toContain('showCount={false}');
    for (const page of ['src/pages/DiamondPlinkoPage.tsx', 'src/pages/DiamondCrashPage.tsx']) {
      expect(src(page)).not.toContain('showCount');
    }
    expect(src('src/components/games/TodayLine.tsx')).toContain(
      'if (parts.length === 0) return null;'
    );
  });

  it('and the line gets louder as the ceiling comes up', () => {
    const line = src('src/components/games/TodayLine.tsx');
    expect(line).toContain('const atWall = capped && used >= cap;');
    expect(line).toContain('used >= cap * 0.8');
    expect(line).toContain("That Is Today's Limit Here");
  });
});

describe('the one blocker with a way out', () => {
  it.each(PAGES)('%s names the shortage once and derives the door from it', (page) => {
    const s = src(page);
    expect(s).toContain('const SHORT_OF_DIAMONDS =');
    expect(s).toContain('const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;');
    // The string may appear only in the constant, never again as a literal.
    const lit = /'Not Enough Diamonds For (That Bet|A Spin)'/g;
    expect(s.match(lit)?.length).toBe(1);
  });

  it.each(PAGES)('%s turns the plate into the door rather than leaving it dead', (page) => {
    const s = src(page);
    expect(s).toContain("const BUY_DIAMONDS = '/marketplace?tab=diamonds';");
    expect(s).toContain(
      "{ label: 'Get Diamonds', ink: 'gold', onClick: () => navigate(BUY_DIAMONDS) }"
    );
  });

  it('an open crash round keeps its cash-out plate whatever the wallet says', () => {
    const s = src('src/pages/DiamondCrashPage.tsx');
    const primary = s.slice(s.indexOf('        primary={'));
    // The money is already on the table; a shortage may not stand in front of
    // getting it back. `open` is tested before the shortage is.
    expect(primary.indexOf('open')).toBeLessThan(primary.indexOf('shortOfDiamonds'));
  });
});

describe('the platform helper finally opens the store it names', () => {
  const t = src('src/components/common/DiamondTopUpToast.ts');

  it('calls the navigate it has always taken', () => {
    expect(t).toContain("() => navigate('/marketplace?tab=diamonds')");
  });

  it('does not yank a player off the felt on its own', () => {
    // It fires mid-hand at a table. The toast is the door; tapping is the act.
    expect(t).not.toMatch(/\n\s*navigate\('\/marketplace/);
    expect(t).toContain('Tap To Get Diamonds');
  });

  it('and says it in the house voice', () => {
    expect(t).not.toContain('Not enough diamonds for');
    expect(t).not.toContain('Top up in the Diamond Store!');
  });
});
