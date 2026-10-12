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
 * corners are permanent by decision, not by accident.
 *
 * Its `grad` read six when this control was written and reads two now, because
 * 2026-10-02 stopped counting the standard's own engraved rule (see the next
 * describe). Four of the six were that hairline. The assertion below is
 * deliberately `> 0` rather than a number, for exactly this reason: what
 * counts as paint is a judgement that gets sharper, and a control should break
 * when the counter goes QUIET, not when it gets more accurate.
 */
const PAINTED_CONTROL = 'src/pages/AdminDashboardPage.tsx';

/* The 2026-10-02 rows, one per defect. See the describe blocks below. */
const SPIN = 'src/components/club/SpinActivationPanel.tsx';
const SPIN_CSS = 'src/components/club/SpinActivationPanel.css';
const CREATE_TABLE = 'src/pages/CreateTablePage.tsx';
const DIAMOND_PLAYERS = 'src/pages/DiamondPlayersPage.tsx';
const ROSTER_CSS = 'src/pages/ClubMembersPage.css';
const ROSTER_CONTRACT = 'tests/components/players-casino-realism-pages.test.tsx';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

interface Row {
  file: string;
  score: number;
  radius: number;
  grad: number;
  hover: number;
  master: number;
  console: number;
  css: string | null;
  spokenFor: boolean;
  ruled: boolean;
  wearsPinned?: string[];
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

describe('an engraved rule is not a frame, and a comment is not a rule', () => {
  /**
   * 2026-10-02. The sweep read "0 to go" on 2026-09-23 and "4 to go" nine days
   * later. THREE of those four surfaces had not changed at all and were already
   * on an approved authority; the scanner had three defects, and each one is the
   * 2026-09-22 lesson left standing one level up (CLAUDE.md 10.86 rule 4).
   *
   * Only the fourth was real: MultiDayStagePanel drew its Open Table control as
   * a 999px pill in CSS, and that is pinned by its own stylesheet, below.
   */

  it('the engraved rule the standard prescribes is not counted as paint', () => {
    /* SKILL.md section 5 step 5 names this divider in full: `border-top: 1px
       solid #000` plus `box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%)`,
       "instead of a drawn divider". 488 of the 1,985 box-shadow declarations in
       src/ are it. Counting them scored the standard against itself. */
    const css = read(SPIN_CSS);
    const shadows = [...css.matchAll(/box-shadow\s*:\s*([^;}]*)/g)].map((m) =>
      m[1]
        .trim()
        .replace(/\s*!important$/, '')
        .trim()
    );
    expect(shadows.length, 'the premise is that this panel declares shadows').toBeGreaterThan(0);
    /* Every one is either a refusal or a hairline: no blur, no spread. */
    expect(
      shadows.filter((v) => v !== 'none' && !/^inset\s+0\s+-?1px\s+0\s/.test(v)),
      'this panel grew a shadow that is not the engraved rule, so the ruling below needs re-reading'
    ).toEqual([]);
    expect(css).not.toMatch(/linear-gradient|radial-gradient/);
  });

  it('a :hover inside a comment is not a :hover', () => {
    /* The heaviest term the scorer has, weighted five times because the real
       thing is forbidden outright - and measured across src/ on 2026-10-02 there
       were ZERO real ones and 109 stylesheets with the word inside a comment.
       The law (tests/no-hover-effects.law.test.ts) has masked comment bodies
       since a sweep matched one and cut a stylesheet in half. The scanner had
       not, so the only thing this counter could ever find was prose, usually a
       comment promising the file has none. SpinActivationPanel.css line 19:
       "the panel is the same picture in all three hosts. No :hover." */
    const css = read(SPIN_CSS);
    const masked = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    expect(css, 'the premise is that this sheet mentions the state in prose').toContain(':hover');
    expect(masked, 'this sheet now has a real hover rule, which is a law violation').not.toContain(
      ':hover'
    );
    expect(row(SPIN)!.hover, 'the scanner is counting comment text again').toBe(0);
  });

  it('so the hosted panel scores zero, having no frame of its own to rebuild', () => {
    /* Same category as BBJBasicPanel in the scanner's RULED map: it prints rows
       on whatever glass its three hosts give it (a settings page, the lobby's
       Spins Wallet popup, the Union Dashboard) and owns no chassis. */
    const r = row(SPIN);
    expect(r, `${SPIN} fell out of the inventory`).toBeDefined();
    expect(r!.grad).toBe(0);
    expect(r!.hover).toBe(0);
    expect(r!.radius).toBe(0);
    expect(r!.score).toBe(0);
  });

  it('the lobby card art counts as a master, which the scanner only claimed before', () => {
    /* The scanner's own comment says "ANY approved master counts, not just the
       console's" and names three authorities, the third being "the lobby's own
       card art". SKILL.md step 1.5 spells it `ArenaGameCard`, `game-cards/`.
       The regex implemented two of the three. CreateTablePage renders nine
       ArenaGameCards and deliberately draws no console around them (Dan
       2026-09-20, quoted in the page: "DO NOT ATTACH EVERYTHING TOGETHER WITH
       THE SAME DISPLAY WINDOWS"), so it was nominated for the one thing it was
       right to leave out. */
    const scanner = read(SCANNER);
    expect(scanner, 'the master test no longer names the lobby card art').toMatch(
      /game-cards\\\/\|ArenaGameCard/
    );
    const page = read(CREATE_TABLE);
    expect(page, `${CREATE_TABLE} no longer renders the lobby card art`).toContain('ArenaGameCard');
    const r = row(CREATE_TABLE);
    expect(r!.master, 'the lobby card art stopped registering as a master').toBeGreaterThan(0);
    expect(r!.score).toBe(0);
  });

  it('a surface wearing a pinned stylesheet is on that authority', () => {
    /* DiamondPlayersPage imports ClubMembersPage.css first and its own 27 lines
       second; its header says so in the first sentence. That sheet is pinned by
       the Players Casino Realism asset and interaction contract, a different
       approved master and therefore finished work (SKILL.md step 1.5). The
       scanner resolved a stylesheet by FILENAME only, so it judged the 27-line
       delta on one `inset 0 -2px 0 var(--members-blue)` underline - the fourth
       of a set whose other three live in the pinned sheet. */
    const page = read(DIAMOND_PLAYERS);
    expect(page, `${DIAMOND_PLAYERS} no longer wears the roster stylesheet`).toMatch(
      /import\s+['"]\.\/ClubMembersPage\.css['"]/
    );
    expect(
      read(ROSTER_CONTRACT),
      `${ROSTER_CONTRACT} no longer pins ${ROSTER_CSS}, so the inheritance below has no source`
    ).toContain(ROSTER_CSS);
    const r = row(DIAMOND_PLAYERS);
    expect(r!.wearsPinned, 'the imported-stylesheet inheritance stopped resolving').toContain(
      ROSTER_CSS
    );
    expect(r!.spokenFor).toBe(true);
    expect(r!.score).toBe(0);
  });

  it('and a real shadow is still paint, across the tree', () => {
    /* The control for all of the above. The point was to stop counting the
       standard's own handwriting, not to stop counting - and a predicate that
       swallowed every shadow would take the inventory to zero by going blind.
       Measured 2026-10-02: 1,325 painted declarations over 111 surfaces, and 40
       surfaces whose `grad` comes from shadows ALONE, their stylesheets holding
       no gradient at all. That last number is the discriminating one: widen the
       hairline test to match a blur or a spread and it collapses. */
    expect(inventory.filter((r) => r.grad > 0).length).toBeGreaterThan(60);
    expect(inventory.reduce((n, r) => n + r.grad, 0)).toBeGreaterThan(600);

    const shadowOnly = inventory.filter((r) => {
      if (!r.css || r.grad === 0) return false;
      return !/linear-gradient|radial-gradient/.test(read(r.css));
    });
    expect(
      shadowOnly.length,
      'no surface is scored on shadows alone any more: the hairline test has swallowed real paint'
    ).toBeGreaterThan(15);
  });

  it('the one real surface stopped drawing its control in CSS', () => {
    /* MultiDayStagePanel was the only one of the four that needed art. Its
       Open Table action was `border-radius: var(--tl-radius-pill, 999px)` over a
       `--tl-surface-raised` fill with a 1px accent border: a control drawn in
       CSS, which SKILL.md section 0 forbids outright. It is a lit word on the
       glass now. The accessible name and the `button` role are pinned by
       tests/components/MultiDayStagePanel.test.tsx and the navigation by
       tests/no-auto-table-switch.law.test.ts; only the paint moved. */
    const css = read('src/components/tournament/details/MultiDayStagePanel.css');
    const code = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(code, 'the Open Table control is a drawn pill again').not.toMatch(/--tl-radius-pill/);
    expect(code, 'the Open Table control grew a fill again').not.toMatch(/--tl-surface-raised/);
    expect(code).toMatch(/\.md-stage__open\s*\{[^}]*background:\s*transparent/);
    const r = row('src/components/tournament/details/MultiDayStagePanel.tsx');
    expect(r!.radius).toBe(0);
    expect(r!.score).toBe(0);
  });
});

describe('the sweep is at zero, and a surface that lands generic says so', () => {
  /**
   * WHY THIS RATCHET EXISTS, AND WHO READS IT.
   *
   * The sweep reached "0 to go" on 2026-09-23 and was back to four nine days
   * later. Nothing in the repo noticed: the inventory is a script an agent runs
   * on purpose, so a surface could land generic and stay generic until somebody
   * thought to look. That is CLAUDE.md 10.83 exactly - a check nobody can see is
   * not a check.
   *
   * THE READER IS THE REQUIRED CLIENT UNIT TESTS CHECK, on the pull request that
   * adds the surface. Not a timer, not a watcher, not a repair job (10.11,
   * 10.12): a ratchet that goes red in the same PR as the cause, naming the
   * file, while the author is still holding it.
   *
   * IF YOU ARE HERE BECAUSE THIS IS RED, you have added or changed a surface
   * that draws its own frame. Three ways out, in order of preference:
   *
   *   1. Put it on an approved master. Read
   *      .claude/skills/club-arena-console/SKILL.md and rebuild it. This is the
   *      answer in almost every case.
   *   2. If it is a house tool no player and no club operator can reach, add it
   *      to INTERNAL_ONLY in the scanner (Dan 2026-09-14). A CLUB owner is a
   *      customer: every operator page they open stays in.
   *   3. If it is finished work on another authority, or Dan has ruled on it,
   *      add it to RULED with the ruling written out.
   *
   * What is NOT a way out: widening a counter so your surface stops matching.
   * The describe above exists because three of those counters were wrong, and it
   * is full of controls precisely so the next correction has to prove it is one.
   */
  it('reports nothing left to rebuild', () => {
    const toGo = inventory.filter((r) => r.score > 0);
    expect(
      toGo.map(
        (r) => `${r.file} (score ${r.score}: radius ${r.radius}, grad ${r.grad}, hover ${r.hover})`
      ),
      'these surfaces draw their own frames. Put them on an approved master (SKILL.md), or rule ' +
        'them off in the scanner with the reason. Do not widen a counter to make this pass.'
    ).toEqual([]);
  });

  it('and it is still looking at the whole tree', () => {
    /* A ratchet that passes because the scan found nothing is the failure mode
       this repo keeps re-learning (10.86 rule 2). Zero to go only means
       something if there were surfaces to judge. */
    expect(inventory.length).toBeGreaterThan(200);
    expect(inventory.filter((r) => r.master + r.console > 0).length).toBeGreaterThan(100);
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
