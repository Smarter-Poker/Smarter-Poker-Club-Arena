#!/usr/bin/env node
/**
 * #ClubArenaConsole - the inventory.
 *
 *   node .claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs [--json]
 *
 * Scores every page and modal in src/ for how far it is from the standard, so
 * a sweep is ordered by evidence instead of by whoever shouted loudest:
 *
 *   radius   PAINTED corner radii          (a rounded card is a drawn frame)
 *   grad     gradients + PAINTED shadows   (paint the art does not need)
 *   master   references to club-buttons/   (art it already uses - lower is worse)
 *   hover    :hover rules                  (forbidden outright)
 *   px       px font sizes                 (should be cqw against the chassis)
 *
 * A surface with master:0 and a high radius+grad is "still generic".
 *
 * PAINTED, because `border-radius: 0` and `box-shadow: none` are the standard's
 * own way of refusing a frame (SKILL.md 3.5) and counting them scored
 * compliance as a violation. See paintedDecls below.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const count = (s, re) => (s.match(re) ?? []).length;

/**
 * A ZEROING DECLARATION IS NOT CHROME (2026-09-22).
 *
 * `border-radius: 0` and `box-shadow: none` do not draw a frame, they REFUSE
 * one - and they are this standard's own handwriting. SKILL.md 3.5 tells every
 * surface inside a dialog to switch the metallic-popups chassis off longhand by
 * longhand with exactly those two declarations, and a surface printed as rows
 * on console glass unpaints its buttons the same way. Counting them as paint
 * scored the standard against itself: LeaderboardSettlementCard renders inside
 * LeaderboardPage's <SpadeConsole> (#4521) and owns no frame at all, yet it was
 * nominated for a rebuild at score 3 - one `border-radius: 0` and one
 * `box-shadow: none`, its only two matching lines in the whole stylesheet. The
 * more correctly a surface followed 3.5, the more generic this said it was.
 *
 * Counted by VALUE rather than by a negative lookahead, because `\s*` before a
 * lookahead backtracks to zero width and the lookahead then passes on the
 * space: `/border-radius\s*:\s*(?!0...)/` matches `border-radius:` in
 * `border-radius: 0;` and reports a painted corner. Read the declaration, then
 * judge it.
 */
const paintedDecls = (style, prop, isZero) =>
  [...style.matchAll(new RegExp(`${prop}\\s*:\\s*([^;}]*)`, 'g'))].filter(
    (m) => !isZero(m[1].trim().replace(/\s*!important$/, '').trim())
  ).length;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(SRC).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f));

/* SPOKEN FOR: any surface a VISUAL test already pins.
   Club Arena has more than one approved authority - the spade console, the
   #SmarterCasinoRealism cinematic routes, the community and account surface
   headers, the lobby's card art, and one page Dan art-directed himself. Those
   are finished work, and rebuilding one turns a written contract red. Rather
   than guess at markers, ask the tests: every page named inside a test that
   pins a LOOK is off the sweep. */
/* Case- and space-insensitive: a test file says "Players Casino Realism" in a
   describe() and "casino-realism" in its filename, and an earlier version of
   this regex saw neither, so MemberManagementPage was handed to an agent as
   generic while an approved credential render sat on it. */
const VISUAL_TEST =
  /casino[\s-]?realism|surface[\s-]?header|visual authority|cinematic|owns its class|black-glass|visual composition|credential/i;
/* NOT "palette" or "wears the house colours": those are COLOUR laws that bind
   every surface, console ones included. They constrain the ink, they do not
   say a surface is finished - and reading them as "spoken for" hid TablePage,
   the most generic surface in the app, behind a law that would have applied to
   its rebuild anyway. */

/* INTERNAL ONLY: Dan, 2026-09-14 - "THESE POP UPS OR EVENT LOGS (IF INTERNAL
   USE ONLY) DO NOT NEED DYNAMIC IMAGES AND POP UPS." A surface no player and
   no club operator can reach - the QA scenario harness, the bus event log,
   the platform's own engine/analytics/ads dashboards - is a tool for the
   house. It is held to the copy laws and the colour schema, never to the
   painted chassis, and it is off the sweep so nobody spends a round of art on
   a page four people open. Anything a CLUB owner reaches is customer-facing
   and stays in. */
const INTERNAL_ONLY = [
  'src/pages/SimPage.tsx',
  'src/pages/BusDevToolsPage.tsx',
  'src/pages/admin/EngineDashboard.tsx',
  'src/pages/admin/AnalyticsDashboard.tsx',
  'src/pages/admin/HouseAdsPage.tsx',
  'src/pages/admin/CommerceDeskPage.tsx',
  'src/pages/AdminDashboardPage.tsx',
  'src/pages/DriftIncidentsPage.tsx',
  'src/pages/ClubFooterShowcasePage.tsx',
  'src/pages/CustomizationStudioShowcasePage.tsx',
];
/* Everything under src/pages/dev/ is a showcase harness by definition. */
const isInternal = (rel) => INTERNAL_ONLY.includes(rel) || rel.startsWith('src/pages/dev/');

/* RULED, WITH THE REASON (2026-09-15). A surface can be finished work without
   a test whose TITLE says so: the artwork contract may be phrased as "the
   three pieces of artwork ship with the bundle", or the decision may be Dan's
   own, made in review. These were the last rows in this inventory, and every
   wave re-derived them from scratch before deciding not to touch them. They
   are written down here instead, each with the ruling that closed it, so the
   count reaches zero and a later agent reads the answer rather than guessing
   at it again. Deleting a line here re-opens that surface deliberately. */
const RULED = {
  'src/components/table/ActionPanel.tsx':
    'Dan art-directed the three action buttons by screenshot (2026-08-26: FOLD = RED, CHECK = BLUE, BET = GREEN) and gameplay-wears-the-house-colours pins those exact gradients; the raise overlay geometry is pinned by actionBarSliderAndFooter. Repainting either deletes a written law s subject.',
  'src/components/table/BombPotOverlay.tsx':
    'Felt cinematics, not a card (Dan 2026-09-09): inked to the schema, never framed in a console.',
  'src/components/table/TournamentAnnouncementOverlay.tsx':
    'Felt cinematics, same ruling as BombPotOverlay; inked 2026-09-14.',
  'src/components/vip/DiamondTopUpModal.tsx':
    'On the #SmarterCasinoRealism master, and diamond-checkout-mobile.spec.ts is its visual contract.',
  'src/components/cash/CashGameCard.tsx':
    'On approved master art: Dan supplied the three cash-card frames and the component prints into zones measured in percent of them. cashGameCard.test.tsx is the contract.',
  'src/components/lobby/game-cards/NlhPremiumCard.tsx':
    'On the approved NLH chassis art; club-lobby-premium-machine.test.ts pins the zone maths and the asset pack.',
  'src/components/lobby/game-cards/layeredCard.tsx':
    'Same approved lobby card family as NlhPremiumCard.',
  'src/components/table/PreviousHandCard.tsx':
    'One of three interchangeable 66px HUD tiles on an approved button asset; all-in-cannot-leave-and-the-hud-slot pins their geometry as a set.',
  'src/components/bbj/BBJBasicPanel.tsx':
    'Already on this standard: it renders as rows on the Bad Beat Jackpot console glass, so it has no frame of its own to rebuild.',
  'src/components/common/Card.tsx':
    'NOT A SURFACE: nothing renders it. All six exports (Card, CardHeader, CardContent, CardFooter, StatCard, FeatureCard) have zero JSX sites in src/; the only importer is the barrel components/common/index.ts, whose only importer is main.tsx taking ErrorBoundary alone. A player never meets it, so painting a chassis on it would change nothing on screen. Retiring it is the real answer and is NOT free: Card.css is a GLOBAL sheet and its .stat-card flex-direction, its .card-header gap and padding still cascade into five live surfaces that never redeclare them (BankrollTracker, stats/StatCard, SuperAgentDashboard, PositionWinRates, admin/EngineDashboard), so the file leaves only once those declarations are re-homed and those five are re-rendered. Premise pinned by tests/unit/consoleInventoryIsHonest.test.ts.',
};

/* UNREACHABLE IS NOT A SWEEP CANDIDATE (2026-09-21).
 *
 * This script used to print " DEAD? " beside any surface with no importer and
 * leave the reader to work out what that meant. On 2026-09-21 the last twelve
 * rows in this inventory were read as "twelve surfaces to go" when NINE of
 * them - ClubDetailPage at score 137 among them, 1,986 lines - cannot be
 * reached from the app entry at all. The repo already knows this and writes it
 * down: tests/every-file-under-src-is-reachable.law.test.ts walks from
 * index.html through every import, re-export and CSS reference, and its
 * RETAINED map lists every file the walk does not reach together with the
 * test, law or CI script that still reads it by path.
 *
 * So ask the law instead of guessing from importer counts. A retained file is
 * off the sweep for the same reason an internal tool is: no player arrives at
 * it, so a round of art spent on it is a round spent on nothing. It is not a
 * deletion instruction either - the law is explicit that removing one means
 * retargeting its reader in the same commit.
 */
const RETAINED_LAW = join(ROOT, 'tests', 'every-file-under-src-is-reachable.law.test.ts');
/** null means COULD NOT TELL - never an empty map, which would read as
 *  "nothing is retained" and put all nine back on the list (CLAUDE.md 10.86). */
const readRetained = () => {
  if (!existsSync(RETAINED_LAW)) return null;
  let text;
  try {
    text = readFileSync(RETAINED_LAW, 'utf8');
  } catch {
    return null;
  }
  const open = text.indexOf('const RETAINED');
  if (open < 0) return null;
  const body = text.slice(open, text.indexOf('\n};', open));
  const out = new Map();
  for (const m of body.matchAll(/'(src\/[^']+)':\s*\n?\s*'([^']*)'/g)) out.set(m[1], m[2]);
  return out.size ? out : null;
};
const retained = readRetained();

const spokenFor = new Set();
try {
  for (const t of walk(join(ROOT, 'tests'))) {
    if (!/\.tsx?$/.test(t)) continue;
    const text = readFileSync(t, 'utf8');
    /* The phrase must be in the FILENAME or in a describe()/it() title - the
       claim "this surface's look is pinned" belongs to the test's subject, not
       to a passing mention in a comment. Scanning the whole body marked
       TablePage as spoken for because an unrelated file said "cinematic"
       somewhere below the fold. */
    const titles = [...text.matchAll(/\b(?:describe|it|test)\s*\(\s*[`'"]([^`'"]{4,160})/g)]
      .map((m) => m[1])
      .join('\n');
    if (!VISUAL_TEST.test(t) && !VISUAL_TEST.test(titles)) continue;
    for (const m of text.matchAll(
      /src\/(?:pages|components)\/[A-Za-z0-9/_-]+(?:\.(?:tsx|module\.css|css))?/g
    )) {
      const hit = m[0].replace(/\.(?:module\.css|css)$/, '.tsx');
      spokenFor.add(hit.endsWith('.tsx') ? hit : `${hit}.tsx`);
    }
  }
} catch {
  /* no tests dir: fall back to the markers below */
}
/* Read every file ONCE. Counting importers by re-reading the tree per surface
   is O(n^2) and takes minutes on this repo.

   `.ts` AS WELL AS `.tsx` (2026-09-21): this map is what the importer count
   below walks, and it used to hold only the surfaces themselves. Every barrel
   in this tree is a `.ts` - `src/components/common/index.ts`,
   `src/components/stats/index.ts`, `src/components/feedback/index.ts` - so a
   component re-exported by its barrel and by nothing else counted ZERO
   importers and printed " DEAD? " next to a file the app renders. It is the
   same mistake the flag is meant to catch, one level up. */
const importScan = walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const sources = new Map(importScan.map((f) => [f, readFileSync(f, 'utf8')]));
const rows = [];
for (const tsx of files) {
  const name = basename(tsx, '.tsx');
  const isSurface = /Page$|Modal$|Sheet$|Panel$|Overlay$|Dialog$|Banner$|Card$/.test(name);
  if (!isSurface) continue;
  const css = [join(dirname(tsx), `${name}.css`), join(dirname(tsx), `${name}.module.css`)].find(
    existsSync
  );
  const src = sources.get(tsx);
  const style = css ? readFileSync(css, 'utf8') : '';
  const both = src + style;
  /* IS IT ALIVE? A stale clone keeps components main has deleted, and a
     redesign of one is a round spent on nothing. Anything with no importer is
     dead or an entry point; check `git cat-file -e origin/main:<path>` before
     you touch it. */
  const rel = tsx.slice(ROOT.length + 1);
  let importers = 0;
  for (const [f, text] of sources) {
    if (f !== tsx && (text.includes(`/${name}'`) || text.includes(`./${name}'`))) importers++;
  }
  const row = {
    file: rel,
    importers,
    css: css ? css.slice(ROOT.length + 1) : null,
    lines: src.split('\n').length,
    /* Painted corners and painted shadows only - see paintedDecls above.
       `!important` is stripped before the judgement because that is how 3.5
       writes the refusal. */
    radius: paintedDecls(style, 'border-radius', (v) => /^0[a-z%]*$/.test(v)),
    grad:
      count(style, /linear-gradient|radial-gradient/g) +
      paintedDecls(style, 'box-shadow', (v) => v === 'none'),
    /* ANY approved master counts, not just the console's. Club Arena carries
       three visual authorities: the spade console (club-buttons/), the
       cinematic route families of #SmarterCasinoRealism (images/challenges/,
       images/stats/, --realism-* tokens, data-arena-surface) and the lobby's
       own card art. A surface on ANY of them is already upgraded - scoring it
       as generic sends an agent to rebuild a page that is pinned by contract
       to a different standard, which is how two pages were nominated at 193
       and 200 despite being finished work. */
    master: count(
      both,
      /club-buttons\/|images\/challenges\/|images\/stats\/|--realism-|data-arena-surface|RewardsSurfaceHeader|CasinoSurfaceHeader/g
    ),
    console: count(src, /SpadeConsole|PlateButton|ZoneText|sc-ink--/g),
    hover: count(style, /:hover/g),
    px: count(style, /font-size:\s*\d+(\.\d+)?px/g),
  };
  row.internalOnly = isInternal(rel);
  row.ruled = Object.prototype.hasOwnProperty.call(RULED, rel);
  if (row.ruled) row.ruling = RULED[rel];
  row.unreachable = retained ? retained.has(rel) : false;
  if (row.unreachable) row.retainedFor = retained.get(rel);
  row.spokenFor = spokenFor.has(rel) || row.internalOnly || row.ruled || row.unreachable;
  row.score =
    row.master + row.console > 0 || row.spokenFor ? 0 : row.radius * 2 + row.grad + row.hover * 5;
  rows.push(row);
}
rows.sort((a, b) => b.score - a.score || b.radius - a.radius);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  console.log('score  radius grad hover px  imp  file');
  for (const r of rows.filter((r) => r.score > 0)) {
    console.log(
      String(r.score).padStart(5),
      String(r.radius).padStart(6),
      String(r.grad).padStart(4),
      String(r.hover).padStart(5),
      String(r.px).padStart(3),
      String(r.importers).padStart(4),
      r.importers === 0 ? ' DEAD? ' : ' ',
      r.file
    );
  }
  const done = rows.filter((r) => r.score === 0);
  const pinned = rows.filter((r) => r.spokenFor).length;
  console.log(
    `\n${done.length} surface(s) already spoken for (${pinned} pinned by a visual test), ` +
      `${rows.length - done.length} to go.`
  );
  if (retained === null) {
    console.log(
      '\nCOULD NOT TELL which surfaces are unreachable: tests/every-file-under-src-is-reachable' +
        '.law.test.ts could not be read. Every row above may include a file no player can\n' +
        'reach. Read that law before taking anything off this list.'
    );
  } else {
    const off = rows.filter((r) => r.unreachable);
    console.log(
      `${off.length} unreachable surface(s) held off the sweep by ` +
        'tests/every-file-under-src-is-reachable.law.test.ts (no player arrives at them; the\n' +
        'law names the reader that still keeps each one, and deleting one means retargeting' +
        ' that reader in the same commit):'
    );
    for (const r of off) console.log(`  ${r.file}  -  ${r.retainedFor}`);
  }
}
