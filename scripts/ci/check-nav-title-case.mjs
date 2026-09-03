#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  check-nav-title-case — focused navigation registry defense
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-21: "First letter of every word is capitalized, that's a hard rule
 * for all forward facing pages."
 * Dan 2026-08-30: "THE FIRST LETTER OF EVERY WORD INSIDE THE HAMBURGER MENU MUST
 * BE CAPITALIZED. AS WELL AS EVERY CLICKABLE PAGE AND SUBPAGE."
 *
 * WHY KEEP A SECOND GATE AFTER WIDENING check-title-case.mjs
 *
 * The general gate now parses static JSX, accessibility attributes, conditional
 * expressions, templates and known copy-bearing registry properties. This
 * focused gate remains as defense in depth for every canonical navigation
 * registry and produces navigation-specific failure messages:
 *
 *   ArenaSectionRail, ClubOperationsRail, QuickActionsBar,
 *   ClubBottomNav, HamburgerMenu - five surfaces, one blind spot.
 *
 * (There were six. Breadcrumbs took its labels from callers, so no source
 * registry could cover it - and on 2026-08-31 it turned out to have had NO
 * callers in its entire history, along with SideNav, NavItem and the barrel
 * exporting all three. That cluster was deleted rather than cased, which is
 * why this list is now five.)
 *
 * Measured when this was written: 55 label/description/eyebrow literals across
 * the three navigation registries were not Title Cased, and had never been,
 * because the only gate that could have seen them is documented not to look.
 * The hamburger was made to case its own labels at render on 2026-08-30, which
 * fixed what a player saw in ONE drawer and left the same strings wrong
 * everywhere else they are rendered.
 *
 * So this gate holds the source end of that promise: in the navigation
 * registries, a `label`, `description` or `eyebrow` string literal must already
 * be Title Cased when it is written down. Fix it once, and every surface that
 * renders it is correct - including surfaces nobody has built yet.
 *
 * SCOPE IS DELIBERATELY NARROW. Only the files in REGISTRIES below, and only
 * those three keys. These are navigation registries whose every string is
 * forward-facing menu copy by construction, which is what makes casing them
 * unambiguous. Do not widen this to all string literals; routes, identifiers,
 * protocol values and CSS tokens are not player-facing prose.
 *
 * Run:  node scripts/ci/check-nav-title-case.mjs [--fix]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const ROOT = new URL('../../', import.meta.url).pathname;

/**
 * Navigation registries: every label/description/eyebrow here is menu copy.
 *
 * The last two are components rather than config files, because they define
 * their destination lists inline. Their labels were already correct when this
 * gate was written - they are listed so they cannot QUIETLY stop being correct,
 * which is the entire failure mode this gate exists for. A rule that covers
 * only the places currently broken is a cleanup, not a gate.
 */
const REGISTRIES = [
  'src/config/clubArenaNavigation.ts',
  'src/config/arenaSectionNavigation.ts',
  'src/config/clubOperationsNavigation.ts',
  'src/config/clubIntegrityNavigation.ts',
  'src/components/navigation/QuickActionsBar.tsx',
  'src/components/club/ClubBottomNav.tsx',

  /*
   * EVERY PAGE, NOT ONLY THE MENU (2026-08-31).
   *
   * Dan: "make sure the first letter of every word on every single page and
   * sub page is capitalized."
   *
   * check-title-case reads JSX TEXT only, and its header says expression
   * values "are cased at their source". Until now the only source anything
   * checked was the six files above, so `{item.label}` anywhere else in the
   * app was covered by a promise nothing kept. Measured: 241
   * label/description/eyebrow literals outside the six sat in sentence case
   * and reached players - the command palette, the report-a-player reasons,
   * the achievement, VIP and stats copy, the password-strength checklist.
   *
   * The header below warns against widening this to "all string literals",
   * and that warning is right: an arbitrary `label:` may be an analytics key
   * or an enum value, not copy. So the test it already applies is applied per
   * file instead of assumed - every file added here contains offending
   * literals AND renders them itself through an expression, which is the same
   * "forward-facing copy by construction" property that makes the six above
   * safe to case.
   *
   * Ten more files hold offending literals but do NOT render them in-file -
   * RakeConfig, AchievementService, VIPService, PayoutEngine, club.types and
   * others. Their consumers have to be read one at a time before their copy
   * can be cased safely, and that is deliberately not done blind here.
   */
  'src/components/admin/AdminCommandPalette.tsx',
  'src/components/gamification/FinancialAchievementBadge.tsx',
  'src/components/moderation/ReportPlayerModal.tsx',
  'src/components/navigation/HamburgerMenu.tsx',
  'src/components/security/PasswordStrength.tsx',
  'src/components/social/FriendChallengeModal.tsx',
  'src/components/stats/AdvancedStatsSummary.tsx',
  'src/components/stats/TrophyRoom.tsx',
  'src/components/table/RealTimeResultPanel.tsx',
  'src/components/vip/RewardsMarketplace.tsx',
  'src/components/vip/VIPBenefitsGrid.tsx',
  'src/components/wallet/DepositWithdrawModal.tsx',
  'src/pages/AchievementsPage.tsx',
  'src/pages/FinancialAdminHub.tsx',
  'src/pages/LeaderboardPage.tsx',
  'src/pages/PlayerStatsPage.tsx',
  'src/pages/SearchPage.tsx',
  'src/pages/VIPPage.tsx',
  'src/pages/club/ClubDashboard.tsx',
  'src/pages/club/ClubDataPage.tsx',
  'src/pages/tournament/TournamentLobbyPage.tsx',
  'src/pages/workspaces/ArenaWorkspacePages.tsx',
];

const KEYS = new Set(['label', 'description', 'eyebrow']);

/** Same list as check-title-case.mjs and src/utils/titleCase.ts. */
const ACRONYMS = new Set([
  'nlh', 'nlhe', 'plo', 'plo4', 'plo5', 'plo6', 'plo8', 'flh', 'flo', 'ofc',
  'nl', 'pl', 'fl', 'sng', 'mtt', 'xmtt', 'pko', 'ko', 'gtd', 'hu', 'wsop',
  'bbj', 'vip', 'id', 'utg', 'sb', 'bb', 'btn', 'co', 'mp', 'hj', 'lj',
  'rit', 'gto', 'ev', 'roi', 'itm', 'usd', 'kyc', 'tos', 'faq', 'api', 'url',
  'pc', 'ios', 'os', 'ui', 'ux', 'qr', 'sms', 'otp', '2fa',
]);

/**
 * Capitalise the first letter of every word. Byte-for-byte the same rule as
 * check-title-case.mjs: interior capitals preserved, acronyms shouted, tokens
 * starting with a digit left alone. Two gates that disagree about what Title
 * Case IS would each be "fixing" the other's output forever.
 */
export function titleCaseText(text) {
  return text.replace(/[A-Za-z][A-Za-z0-9'’]*/g, (word, offset, whole) => {
    const before = whole.slice(Math.max(0, offset - 1), offset);
    if (before === '&') return word;
    if (/^[0-9]/.test(word)) return word;
    const lower = word.toLowerCase();
    if (ACRONYMS.has(lower)) return lower.toUpperCase();
    if (word.length > 1 && word === word.toUpperCase()) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

const fix = process.argv.includes('--fix');
const offenders = [];
let fixedNodes = 0;
let fixedFiles = 0;

for (const rel of REGISTRIES) {
  const file = join(ROOT, rel);
  let original;
  try {
    original = readFileSync(file, 'utf8');
  } catch {
    // A registry that has been renamed or removed is not this gate's business.
    continue;
  }

  const sf = ts.createSourceFile(
    rel,
    original,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const changes = [];

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      KEYS.has(node.name.text) &&
      ts.isStringLiteral(node.initializer)
    ) {
      const value = node.initializer.text;
      const cased = titleCaseText(value);
      if (cased !== value) {
        changes.push({
          key: node.name.text,
          value,
          cased,
          // The literal's own span, quotes included, so the replacement keeps
          // whatever quote style the file already uses.
          start: node.initializer.getStart(sf),
          end: node.initializer.getEnd(),
          line: original.slice(0, node.initializer.getStart(sf)).split('\n').length,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);

  if (changes.length === 0) continue;

  if (fix) {
    let out = original;
    // Back to front, so earlier offsets stay valid.
    for (let i = changes.length - 1; i >= 0; i--) {
      const c = changes[i];
      const quote = original[c.start];
      // Only quote styles that need no escaping analysis. A template literal or
      // a value containing the quote character is reported, never rewritten.
      if ((quote !== "'" && quote !== '"') || c.cased.includes(quote)) continue;
      out = out.slice(0, c.start) + quote + c.cased + quote + out.slice(c.end);
      fixedNodes++;
    }
    if (out !== original) {
      writeFileSync(file, out, 'utf8');
      fixedFiles++;
    }
  } else {
    for (const c of changes) {
      offenders.push(`${rel}:${c.line}: ${c.key}: "${c.value}"  ->  "${c.cased}"`);
    }
  }
}

if (fix) {
  console.log(
    `check-nav-title-case: fixed ${fixedNodes} navigation label(s) across ${fixedFiles} registry file(s).`
  );
  process.exit(0);
}

if (offenders.length > 0) {
  console.error(
    '\ncheck-nav-title-case FAILED: navigation copy is not Title Cased at its source.\n'
  );
  console.error('These strings are rendered through navigation registries. This focused');
  console.error('gate keeps their source contract explicit in addition to the general gate.');
  console.error('Run: node scripts/ci/check-nav-title-case.mjs --fix\n');
  offenders.slice(0, 60).forEach((o) => console.error('  ' + o));
  if (offenders.length > 60) console.error(`  ... and ${offenders.length - 60} more`);
  console.error('');
  process.exit(1);
}

console.log('check-nav-title-case: OK - every navigation label is Title Cased at its source.');
