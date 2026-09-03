/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SEVEN TABS STAY CLEAN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These are source-level assertions, deliberately. The seven tabs of the
 * tournament lobby were written in parallel by seven agents who could not see
 * each other's work, and the failure mode of that is not a crash - it is drift:
 * a second copy of a helper, an interval nobody cleared, a warm hue creeping
 * back onto a palette that forbids one, one tab guarding a null the tab beside
 * it dereferences.
 *
 * A behavioural test cannot catch "somebody added a second payout parser". This
 * file can, and it costs a few milliseconds. Each case names the defect it is
 * standing in front of.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const DIR = path.join(process.cwd(), 'src/components/tournament/details');

const TAB_FILES = [
  'DetailOverviewTab.tsx',
  'BlindsTab.tsx',
  'RankingTab.tsx',
  'EntriesTab.tsx',
  'UnionsTab.tsx',
  'TablesTab.tsx',
  'RewardsTab.tsx',
];

const CSS_FILES = [
  'DetailOverviewTab.css',
  'BlindsTab.css',
  'RankingTab.css',
  'EntriesTab.css',
  'UnionsTab.css',
  'TablesTab.css',
  'RewardsTab.css',
];

const read = (name: string) => fs.readFileSync(path.join(DIR, name), 'utf8');

/** Comment lines say what a file MUST NOT do; only real code is evidence. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

/* ═══════════════════════════════════════════════════════════════════════════
   NOTHING LEAKS
   These tabs mount and unmount every single time a player touches the tab
   strip. A timer or a listener that survives one of those compounds fast.
   ═══════════════════════════════════════════════════════════════════════════ */

describe('every tab cleans up after itself', () => {
  it.each(TAB_FILES)('%s clears every interval it starts', (file) => {
    const code = codeOnly(read(file));
    expect(count(code, 'clearInterval')).toBeGreaterThanOrEqual(count(code, 'setInterval('));
  });

  it.each(TAB_FILES)('%s removes every listener it adds', (file) => {
    const code = codeOnly(read(file));
    expect(count(code, 'removeEventListener')).toBeGreaterThanOrEqual(
      count(code, 'addEventListener')
    );
  });

  it.each(TAB_FILES)('%s clears every timeout it schedules', (file) => {
    const code = codeOnly(read(file));
    expect(count(code, 'clearTimeout')).toBeGreaterThanOrEqual(count(code, 'setTimeout('));
  });

  it('the one tab that opens a realtime channel also closes it', () => {
    const code = codeOnly(read('RankingTab.tsx'));
    expect(code).toContain('getOrCreateChannel');
    expect(code).toContain('removeRegisteredChannel');
  });

  it.each(TAB_FILES)('%s guards its async effects against a late setState', (file) => {
    const code = codeOnly(read(file));
    // Every tab that awaits anything has to be able to say "not any more".
    if (!/await |\.then\(/.test(code)) return;
    expect(/cancelled|alive|isMounted/.test(code)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   NOTHING IS DEFINED TWICE
   ═══════════════════════════════════════════════════════════════════════════ */

describe('shared logic lives in types.ts and nowhere else', () => {
  it('no tab carries its own payout-structure parser', () => {
    // There were three. Detail's counted a range row as one paid place, which
    // moved the money bubble and blanked podium prizes.
    for (const file of TAB_FILES) {
      const code = codeOnly(read(file));
      expect(code, `${file} re-declares the parser`).not.toMatch(
        /function\s+(parsePayoutStructure|payoutRows|payoutPlaces)\b/
      );
    }
  });

  it('no tab carries its own definition of who is still in', () => {
    // Four tabs had four answers, and two of them disagreed about a winner.
    for (const file of TAB_FILES) {
      const code = codeOnly(read(file));
      expect(code, `${file} re-declares the field predicate`).not.toMatch(
        /function\s+(isOut|isLive|isStillIn)\s*\(/
      );
    }
  });

  it('no tab carries its own prize-pool-versus-guarantee rule', () => {
    for (const file of TAB_FILES) {
      const code = codeOnly(read(file));
      expect(code, `${file} re-derives the effective pool`).not.toMatch(
        /Math\.max\(\s*(dbPool|pool)\s*,\s*guarantee\s*\)/
      );
    }
  });

  it('the shared helpers are actually exported for them to use', () => {
    const types = read('types.ts');
    for (const name of [
      'parsePayoutStructure',
      'paidPlaceCount',
      'placePrize',
      'effectivePrizePool',
      'isPlayerOut',
      'isPlayerLive',
      'chips',
      'chipsCompact',
      'ordinal',
      'clockText',
      'initials',
    ]) {
      expect(types).toContain(`export function ${name}`);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE HOUSE RULES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('house rules', () => {
  it.each([...TAB_FILES, 'types.ts', 'useDownlineIds.ts'])('%s never uses .single()', (file) => {
    expect(codeOnly(read(file))).not.toContain('.single()');
  });

  it.each(TAB_FILES)('%s formats numbers without padStart', (file) => {
    // `padStart` on a chip count is the Bad Beat Jackpot bug. `clockText` in
    // types.ts pads a clock, which is what padStart is actually for.
    expect(codeOnly(read(file))).not.toContain('padStart');
  });

  it.each([...TAB_FILES, ...CSS_FILES, 'types.ts', 'useDownlineIds.ts'])(
    '%s contains no emoji',
    (file) => {
      // Bare emoji break the SWC compiler and fail the build.
      expect(read(file)).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  );

  it.each(TAB_FILES)('%s never calls the AI players bots', (file) => {
    expect(read(file).toLowerCase()).not.toMatch(/\bbots?\b/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE PALETTE
   Strict smarter.poker. No brown, no yellow, no gold - including on a podium
   and on a club-level badge, which are the two places every stock design
   reaches for metal.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Hue in degrees, and saturation 0..1, for a #rrggbb or #rgb literal. */
function hueSat(hex: string): { hue: number; sat: number } {
  const full =
    hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex.slice(0, 7);
  const r = parseInt(full.slice(1, 3), 16) / 255;
  const g = parseInt(full.slice(3, 5), 16) / 255;
  const b = parseInt(full.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  let hue: number;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, sat: max === 0 ? 0 : d / max };
}

describe('the palette holds', () => {
  it.each([...CSS_FILES, '../../../styles/tournament-lobby-3d.css'])(
    '%s uses no brown, yellow or gold',
    (file) => {
      const source = fs.readFileSync(path.join(DIR, file), 'utf8');
      const offenders = (source.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((hex) => {
        if (hex.length !== 4 && hex.length !== 7 && hex.length !== 9) return false;
        const { hue, sat } = hueSat(hex);
        // 20 to 70 degrees is orange through gold through yellow. Red (0) is
        // the refusal colour and green (145) is --tl-good; both are allowed.
        return sat > 0.15 && hue >= 20 && hue <= 70;
      });
      expect(offenders, `${file} carries a warm hue`).toEqual([]);
    }
  );

  it.each(CSS_FILES)('%s respects prefers-reduced-motion', (file) => {
    expect(read(file)).toContain('prefers-reduced-motion');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   REALTIME
   ═══════════════════════════════════════════════════════════════════════════ */

describe('the ranking board handles a burst without thrashing', () => {
  const code = codeOnly(read('RankingTab.tsx'));

  it('coalesces realtime patches instead of sorting once per event', () => {
    // Twenty tables finishing a hand inside one second used to cost twenty
    // sorts and twenty reconciles of a thousand-row list.
    expect(code).toContain('FLUSH_MS');
    expect(code).toContain('queuePatch');
  });

  it('never writes a field the payload did not carry', () => {
    // A partial row blanking a column the props already hold is a bug this
    // lobby has actually shipped.
    expect(code).toContain("typeof row.chips === 'number'");
    expect(code).toContain("typeof row.status === 'string'");
    expect(code).toContain('row.table_id !== undefined');
  });

  it('drops an overlay entry once the props agree with it', () => {
    // Without this a stale overlay out-votes a newer prop forever, and it looks
    // like the board froze for one player.
    expect(code).toMatch(/chipsAgree|statusAgree/);
  });

  it('assigns rank over the whole field, before any filter', () => {
    // An agent filtering to their own players must still read a true position.
    expect(code).toContain('const ranked = useMemo');
    expect(code).toMatch(/visible\.map/);
  });
});
