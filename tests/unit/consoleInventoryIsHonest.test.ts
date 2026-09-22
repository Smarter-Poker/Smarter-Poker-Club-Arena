/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CONSOLE INVENTORY ONLY NOMINATES WORK THAT EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `.claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs` is what
 * decides where a round of art gets spent. On 2026-09-22 the last two rows it
 * printed were both wrong, in two different ways, and this file pins the fix to
 * each one so neither verdict can rot back into the list.
 *
 *  1. A ZEROING DECLARATION IS NOT CHROME.
 *     `border-radius: 0` and `box-shadow: none` refuse a frame; they do not
 *     draw one. SKILL.md 3.5 tells every surface inside a dialog to switch the
 *     metallic-popups chassis off with exactly those two declarations, so the
 *     scanner was scoring the standard's own handwriting as a violation of it.
 *     LeaderboardSettlementCard renders inside LeaderboardPage's SpadeConsole
 *     and owns no frame at all, and it was nominated for a rebuild on the
 *     strength of one zeroed corner and one refused shadow.
 *
 *  2. A PRIMITIVE NOTHING RENDERS IS NOT A SURFACE.
 *     `src/components/common/Card.tsx` is reachable - the barrel re-exports it
 *     and main.tsx imports the barrel - but no JSX anywhere mounts any of its
 *     six exports. The scanner's RULED map carries that ruling; this file
 *     carries its premise, so the day something renders a Card the ruling goes
 *     red instead of quietly becoming false.
 *
 * Both checks fail LOUDLY when they cannot tell (CLAUDE.md 10.86 rule 2): an
 * import scan that finds nothing is a broken scan, not good news, so the
 * "nobody renders it" assertions require the import edges to have been found
 * first.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const SCANNER = '.claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs';
const CARD = 'src/components/common/Card.tsx';
const BARREL = 'src/components/common/index.ts';
const SETTLEMENT = 'src/components/leaderboard/LeaderboardSettlementCard.tsx';
const SETTLEMENT_CSS = 'src/components/leaderboard/LeaderboardSettlementCard.css';
/**
 * The control for "the scorer can still say no".
 *
 * NEVER POINT THIS AT A SURFACE ON THE SWEEP. The first version of this test
 * used `ClubAdvertisePage`, which was the top row of the inventory at the time
 * and therefore the single most likely file in the repo to stop being painted:
 * #5083 rebuilt it on the console while this PR's checks were running and the
 * control went red for the best possible reason. A control has to be something
 * nobody is coming for.
 *
 * `AdminDashboardPage` is that: it is in the scanner's own INTERNAL_ONLY list,
 * which is Dan's 2026-09-14 ruling that a house tool no player and no club
 * operator reaches never gets a round of art spent on it. Its fifteen painted
 * corners and six gradients are permanent by decision, not by accident.
 */
const PAINTED_CONTROL = 'src/pages/AdminDashboardPage.tsx';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

interface Row {
  file: string;
  score: number;
  radius: number;
  grad: number;
  spokenFor: boolean;
  ruled: boolean;
}

/** The scanner's own answer, not a re-implementation of it. */
const inventory: Row[] = JSON.parse(
  execFileSync('node', [SCANNER, '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
);
const row = (file: string) => inventory.find((r) => r.file === file);

describe('a zeroing declaration is not chrome', () => {
  it('the scanner produced rows at all', () => {
    expect(inventory.length).toBeGreaterThan(100);
  });

  it('LeaderboardSettlementCard has nothing but zeroing declarations in its stylesheet', () => {
    const css = read(SETTLEMENT_CSS);
    const corners = [...css.matchAll(/border-radius\s*:\s*([^;}]*)/g)].map((m) => m[1].trim());
    const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}]*)/g)].map((m) => m[1].trim());
    /* If this surface ever paints a real corner or a real shadow it has grown
       a frame of its own, and the ruling below is no longer the right one. */
    expect(corners.length, 'the premise is that this surface zeroes a corner').toBeGreaterThan(0);
    expect(
      corners.every((v) => /^0[a-z%]*$/.test(v)),
      `painted corners: ${corners}`
    ).toBe(true);
    expect(
      shadows.every((v) => v === 'none'),
      `painted shadows: ${shadows}`
    ).toBe(true);
    expect(css).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it('so the scanner scores it zero and does not nominate it', () => {
    const r = row(SETTLEMENT);
    expect(r, `${SETTLEMENT} fell out of the inventory`).toBeDefined();
    expect(r!.radius).toBe(0);
    expect(r!.grad).toBe(0);
    expect(r!.score).toBe(0);
  });

  it('it is printed inside the board console, which is why it owns no frame', () => {
    const page = read('src/pages/LeaderboardPage.tsx');
    const open = page.indexOf('<SpadeConsole');
    const close = page.indexOf('</SpadeConsole>');
    const mount = page.indexOf('<LeaderboardSettlementCard');
    expect(open, 'LeaderboardPage no longer opens a SpadeConsole').toBeGreaterThan(-1);
    expect(mount, 'LeaderboardPage no longer renders the settlement card').toBeGreaterThan(-1);
    expect(
      mount > open && mount < close,
      'the settlement card moved outside the console: it now needs a chassis of its own'
    ).toBe(true);
  });

  it('and real paint is still counted, on a surface nobody is coming for', () => {
    /* The point of the fix is to stop counting refusals, not to stop counting.
       A guard that can only ever say "fine" is not a guard (CLAUDE.md 10.86). */
    const r = row(PAINTED_CONTROL);
    expect(r, `${PAINTED_CONTROL} fell out of the inventory`).toBeDefined();
    expect(r!.radius, 'painted corners stopped counting').toBeGreaterThan(0);
    expect(r!.grad, 'painted shadows and gradients stopped counting').toBeGreaterThan(0);
  });

  it('and the counters did not go quiet across the tree', () => {
    /* The single control above proves the rule; this proves it did not survive
       by luck. If a change to paintedDecls zeroed the counters wholesale, the
       inventory would report every surface as finished and the sweep would end
       by going blind rather than by running out of work. */
    expect(inventory.filter((r) => r.radius > 0).length).toBeGreaterThan(20);
    expect(inventory.filter((r) => r.grad > 0).length).toBeGreaterThan(20);
  });
});

describe('the Card primitive is ruled off the sweep because nothing renders it', () => {
  const cardSource = read(CARD);
  const exported = [
    ...cardSource.matchAll(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/g),
  ].map((m) => m[1]);

  /** Every (file, local binding) pair that can put a common/Card export on screen. */
  function renderSites(): { pairs: Array<[string, string]>; edges: number } {
    const pairs: Array<[string, string]> = [];
    let edges = 0;

    const names = (clause: string) =>
      clause
        .replace(/[{}]/g, '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
          const parts = p.split(/\s+as\s+/);
          return (parts[1] ?? parts[0]).trim();
        })
        .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));

    const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

    // 1. Direct importers of common/Card.
    const direct = new Map<string, string[]>();
    for (const f of files) {
      if (f === CARD) continue;
      for (const m of read(f).matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
        if (!/(^|\/)(common\/)?Card$/.test(m[2])) continue;
        if (
          !m[2].includes('common/Card') &&
          !(f.startsWith('src/components/common/') && m[2] === './Card')
        )
          continue;
        edges++;
        direct.set(f, [...(direct.get(f) ?? []), ...names(m[1])]);
      }
    }

    // 2. Barrels that re-export it, and what each importer of a barrel takes.
    const reexported = new Map<string, string[]>();
    for (const f of files) {
      for (const m of read(f).matchAll(/export\s+(\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g)) {
        if (m[2] !== './Card') continue;
        edges++;
        reexported.set(f, names(m[1]));
      }
    }
    for (const f of files) {
      for (const m of read(f).matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
        for (const [barrel, exposed] of reexported) {
          const dir = barrel.replace(/\/index\.tsx?$/, '');
          if (!m[2].endsWith(dir.replace(/^src\//, '')) && !m[2].endsWith(dir)) continue;
          const taken = names(m[1]).filter((n) => exposed.includes(n));
          if (taken.length) {
            edges++;
            direct.set(f, [...(direct.get(f) ?? []), ...taken]);
          }
        }
      }
    }

    for (const [f, bindings] of direct) {
      const text = read(f);
      for (const b of new Set(bindings)) {
        if (new RegExp(`<${b}[\\s/>]`).test(text)) pairs.push([f, b]);
      }
    }
    return { pairs, edges };
  }

  it('reads as a design-system primitive with several component exports', () => {
    expect(exported).toEqual(
      expect.arrayContaining(['Card', 'CardHeader', 'CardContent', 'CardFooter'])
    );
  });

  it('the import scan found its edges (an empty scan is a broken scan)', () => {
    expect(renderSites().edges, 'no import edge to common/Card was found at all').toBeGreaterThan(
      0
    );
    expect(read(BARREL)).toMatch(/from\s+['"]\.\/Card['"]/);
  });

  it('no file mounts anything it exports', () => {
    const { pairs } = renderSites();
    expect(
      pairs.map(([f, b]) => `${b} in ${f}`),
      'something renders a common/Card export now, so the RULED entry in ' +
        `${SCANNER} is out of date: re-open the surface or move that caller onto SpadeConsole`
    ).toEqual([]);
  });

  it('the scanner carries the ruling, with a reason', () => {
    const scanner = read(SCANNER);
    const entry = new RegExp(`'${CARD}':\\s*\\n?\\s*'([^']{80,})'`).exec(scanner);
    expect(entry, `${CARD} is not in the scanner's RULED map with a reason`).not.toBeNull();
    const r = row(CARD);
    expect(r!.ruled).toBe(true);
    expect(r!.score).toBe(0);
  });
});
