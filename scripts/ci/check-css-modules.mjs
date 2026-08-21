#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CSS MODULE CLASS CHECK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fails when a component reads `styles.foo` from a CSS module that defines no
 * `.foo`.
 *
 * WHY THIS EXISTS. On 2026-08-21 a stylesheet was replaced wholesale to swap a
 * font and was never reconciled against its markup: 21 classes the page still
 * rendered were left undefined, including `.page` itself. CSS modules resolve a
 * missing key to `undefined`, React drops `className={undefined}` silently, and
 * the result is an element that ships with NO class at all. Nothing throws,
 * nothing warns, the build is green, the tests pass -- the page just quietly
 * loses its title, its layout width, its background and its countdown badge.
 *
 * There is no runtime signal for this, so it has to be caught here.
 *
 * Deliberately conservative: it only reports a key that is read through a
 * plain `styles.<name>` member access against a stylesheet the same file
 * imports, and only when the stylesheet contains no such class anywhere in any
 * selector. Dynamic access (styles[expr]) is skipped rather than guessed at.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';

const ROOT = resolve(process.cwd(), 'src');

/**
 * KNOWN OFFENDERS, frozen 2026-08-21.
 *
 * Turning this check on surfaced 25 pre-existing instances of the same bug on
 * nine other pages. They are listed rather than fixed here because inventing a
 * design for someone else's modal or empty state is a worse outcome than
 * leaving it visibly unstyled and recorded -- and because a check that lands
 * red is a check somebody disables.
 *
 * The list may only ever SHRINK. Anything not on it fails the build today, so
 * no new instance can land while these are worked off. Delete each entry as
 * its class is defined; the check fails if an entry here is already fixed, so
 * the list cannot rot into a permanent excuse.
 */
const BASELINE = new Set([
  'pages/AgentManagementPage.tsx:playersSection',
  'pages/CashierTradePage.tsx:memberCount',
  'pages/CashierTradePage.tsx:retryBtn',
  'pages/ClubDetailPage.tsx:membersContainer',
  'pages/ClubDetailPage.tsx:tableInfo',
  'pages/ClubDetailPage.tsx:tableSeats',
  'pages/ProfilePage.tsx:bonusButton',
  'pages/ProfilePage.tsx:bonusWheelModal',
  'pages/ProfilePage.tsx:bonusWheelOverlay',
  'pages/ProfilePage.tsx:emptyAchievements',
  'pages/ProfilePage.tsx:emptyProfile',
  'pages/ProfilePage.tsx:modalClose',
  'pages/ProfilePage.tsx:socialContainer',
  'pages/SettingsPage.tsx:cancelBtn',
  'pages/SettingsPage.tsx:input',
  'pages/SettingsPage.tsx:modal',
  'pages/SettingsPage.tsx:modalActions',
  'pages/SettingsPage.tsx:modalOverlay',
  'pages/SettingsPage.tsx:saveBtn',
  'pages/SettingsPage.tsx:statusBadge',
  'pages/SettlementPage.tsx:error',
  'pages/UnionDetailPage.tsx:emptyState',
  'pages/UnionDetailPage.tsx:sectionHeader',
  'pages/UnionDetailPage.tsx:tournamentsContainer',
  'pages/tournament/TournamentLobbyPage.tsx:skeletonGrid',
]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const failures = [];
const seen = new Set();

for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');

  // `import styles from './X.module.css'` -- capture the local binding too, so
  // a file that names it something other than `styles` is still checked.
  const imp = src.match(/import\s+(\w+)\s+from\s+['"]([^'"]+\.module\.css)['"]/);
  if (!imp) continue;
  const [, binding, rel] = imp;

  let css;
  try {
    css = readFileSync(resolve(dirname(file), rel), 'utf8');
  } catch {
    failures.push(`${file}: imports ${rel}, which does not exist`);
    continue;
  }

  // Strip comments so a class named only inside a comment does not count as
  // defined. Then take every class token from every selector.
  const defined = new Set(
    (css.replace(/\/\*[\s\S]*?\*\//g, '').match(/\.[a-zA-Z_][\w-]*/g) || []).map((c) => c.slice(1))
  );

  const used = new Set();
  const re = new RegExp(`\\b${binding}\\.([a-zA-Z_]\\w*)`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) used.add(m[1]);

  for (const key of [...used].sort()) {
    if (defined.has(key)) continue;
    const id = `${relative(ROOT, file).split(sep).join('/')}:${key}`;
    seen.add(id);
    if (BASELINE.has(id)) continue;
    failures.push(`${file}: uses ${binding}.${key}, but ${rel} defines no .${key}`);
  }
}

// A baseline entry that no longer reproduces has been fixed: drop it, so the
// list keeps shrinking instead of quietly outliving the problem.
const stale = [...BASELINE].filter((b) => !seen.has(b));
if (stale.length > 0) {
  console.error('check-css-modules: FAILED\n');
  console.error('  These baseline entries are already fixed. Remove them from BASELINE:');
  for (const s2 of stale) console.error('    ' + s2);
  process.exit(1);
}

if (failures.length > 0) {
  console.error('check-css-modules: FAILED\n');
  for (const f of failures) console.error('  ' + f);
  console.error(
    `\n${failures.length} missing class definition(s). These render as className={undefined},\n` +
      'so the element ships with no styling at all and nothing warns at runtime.'
  );
  process.exit(1);
}

console.log(
  `check-css-modules: OK - every styles.* key has a matching class ` +
    `(${BASELINE.size} known pre-existing offenders still on the baseline).`
);
