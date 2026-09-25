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
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  functionBody as body,
  latestDeclaring as inForce,
  migrationFiles,
  readMigration,
} from './helpers/migrations';

const ROOT = resolve(__dirname, '..');

const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// Replacing a reader preserves its existing ACL, view, and indexes. Resolve each
// independent DDL statement from the ordered history instead of requiring a later
// function-only migration to redeclare the whole schema.
function lastDdl(pattern: RegExp): string {
  const matches = migrationFiles().flatMap((name) => [...readMigration(name).matchAll(pattern)]);
  if (!matches.length) throw new Error(`No migration matches ${pattern}`);
  return matches[matches.length - 1][0];
}

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

  it('it counts the wheel and the shared book of all four bonus games', () => {
    expect(SPENT).toContain('FROM public.wheel_spins s');
    expect(SPENT).toContain('FROM public.diamond_game_round_book r');
    const sql = lastDdl(/CREATE (?:OR REPLACE )?VIEW public\.diamond_game_round_book AS[\s\S]*?;/g);
    for (const table of [
      'plinko_drops',
      'crash_rounds',
      'diamond_choice_rounds',
      'diamond_bonus_entries',
    ])
      expect(sql).toContain(`FROM public.${table}`);
  });

  it('on the same day the caps are counted on, so both turn together', () => {
    expect(SPENT.match(/AT TIME ZONE 'America\/Chicago'\)::date/g)?.length).toBe(4);
    expect(body(inForce('fn_wheel_spin_core').sql, 'fn_wheel_spin_core')).toContain(
      "AT TIME ZONE 'America/Chicago')::date"
    );
  });

  it('a welcome spin costs nothing, so it counts for nothing', () => {
    expect(SPENT).toContain('NOT COALESCE(s.is_welcome, false)');
  });

  it('a claimed Daily Bonus entry is Mint funded, so it is not player spending', () => {
    expect(SPENT).toContain('s.bonus_ticket_id IS NULL');
  });

  it('an OPEN crash round counts, which is the opposite of what the P and L does', () => {
    // Deliberate: the operator's profit is not real until the round decides,
    // and the player's money is gone the moment they bet it.
    expect(SPENT).not.toContain("r.status<>'open'");
    expect(body(inForce('fn_diamond_game_pnl').sql, 'fn_diamond_game_pnl')).toContain(
      "r.status<>'open'"
    );
  });

  it('no browser role may call it, and the per-player day is indexed', () => {
    for (const role of ['PUBLIC', 'anon', 'authenticated']) {
      const acl = lastDdl(
        new RegExp(
          `(?:GRANT|REVOKE)[^;]*ON FUNCTION public\\.fn_diamond_games_spent_today\\(uuid,\\s*uuid\\)[^;]*\\b${role}\\b[^;]*;`,
          'g'
        )
      );
      expect(acl).toMatch(/^REVOKE ALL/);
    }
    for (const ix of [
      'wheel_spins_host_user_time',
      'plinko_drops_host_user_time',
      'crash_rounds_host_user_time',
    ]) {
      const ddl = lastDdl(new RegExp(`(?:CREATE|DROP) INDEX[^;]*\\b${ix}\\b[^;]*;`, 'g'));
      expect(ddl).toContain(`CREATE INDEX IF NOT EXISTS ${ix}`);
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
  it('Plinko and the new games keep Buy More in their shared entry setup', () => {
    const setup = src('src/components/games/BonusSetup.tsx');
    // The door leaves through the page (review 2026-09-22): the page lets go of
    // its bonus hold and navigates. A plain navigate from the setup ran into
    // that hold while a won game waited, and the door opened nothing.
    expect(setup).toContain("exit('/marketplace?tab=diamonds')");
    expect(setup).toMatch(/if \(!disabled\) leave\(to\);/);
    expect(setup).toContain('Buy More');
    expect(setup).toContain('disabled={disabled}');
    for (const page of ['src/pages/DiamondPlinkoPage.tsx', 'src/pages/DiamondChoicePage.tsx'])
      expect(src(page)).toContain('<BonusSetup');
  });
  it.each(PAGES.filter((p) => !p.includes('Plinko')))(
    '%s names the shortage once and derives the door from it',
    (page) => {
      const s = src(page);
      expect(s).toContain('const SHORT_OF_DIAMONDS =');
      expect(s).toContain('const shortOfDiamonds = blocker === SHORT_OF_DIAMONDS;');
      // The string may appear only in the constant, never again as a literal.
      const lit = /'Not Enough Diamonds For (That Bet|A Spin)'/g;
      expect(s.match(lit)?.length).toBe(1);
    }
  );

  it.each(PAGES.filter((p) => !p.includes('Plinko')))(
    '%s turns the plate into the door rather than leaving it dead',
    (page) => {
      const s = src(page);
      expect(s).toContain("const BUY_DIAMONDS = '/marketplace?tab=diamonds';");
      expect(s).toContain(
        "{ label: 'Get Diamonds', ink: 'gold', onClick: () => navigate(BUY_DIAMONDS) }"
      );
    }
  );

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
