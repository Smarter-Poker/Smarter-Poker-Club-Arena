#!/usr/bin/env node
/**
 * check-allin-pointer-events.mjs
 *
 * BLOCKING CI GUARD — 2026-08-15 all-in dead-buttons incident.
 *
 * What happened
 * ─────────────
 * Facing an all-in, the hero's Call and Fold buttons did nothing. The clock ran
 * to zero and the hand was force-folded. Production hand #1315 shows 30.1s
 * between the river shove and the forced fold. Real money, real player, and the
 * engine was healthy the entire time.
 *
 * The cause was one CSS declaration:
 *
 *     .table-page--allin-mode .action-panel { pointer-events: none; }
 *
 * The intent was to visually de-emphasise the panel during the runout. The
 * effect was that every click was swallowed before it reached React. No unit
 * test, integration test, or engine assertion can catch this — the handler is
 * wired correctly and would fire if it ever received the event. The only
 * durable defence is asserting the declaration never comes back.
 *
 * Dimming is fine. Dimming was never the bug. Swallowing input is the bug.
 *
 * Scope (widened 2026-08-15 after an audit found the first version trivially
 * bypassable — it only knew three class names in one file):
 *   - EVERY .css file under src/, not just TablePage.css. `.action-panel` is
 *     also styled in components/table/ActionPanel.css.
 *   - The real button class is `.action-btn` (ActionPanel.css), which the
 *     original selector list did not contain at all. `.table-page--allin-mode
 *     .action-btn { pointer-events: none }` reproduced the incident exactly and
 *     passed CI.
 *   - `pointer-events` is an INHERITED property, so setting it on the mode root
 *     (`.table-page--allin-mode { pointer-events: none }`) disables every
 *     descendant including the panel. TablePage.css already contains that
 *     selector twice, one of them an empty block holding only a comment — the
 *     most inviting place in the file to add a declaration.
 *   - Inline React styles: `style={{ pointerEvents: isAllInMode ? 'none' : ...}}`
 *     is not CSS at all and was completely invisible.
 *
 * Legitimate exceptions exist — a decorative scrim or a ::after overlay SHOULD
 * be pointer-events:none so clicks pass through to the buttons underneath.
 * Pseudo-elements are exempt automatically. Anything else needs an explicit
 * opt-out on the preceding line, so the reason is recorded in the diff:
 *
 *     /* allow-pointer-events-lockout: decorative scrim, must not eat clicks *\/
 *     .table-page--allin-mode .action-panel__scrim { pointer-events: none; }
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = resolve(root, 'src');

const ALLIN = /allin-mode|all-in-mode|allInMode|isAllIn/i;
// Every class that is, or is a descendant element of, the hero's action
// controls. The `(?![a-z0-9])` rather than `\b` is deliberate: `\b` treats the
// underscore in a BEM element name as a word character, so `.action-panel__x`
// did NOT match and every BEM child of the panel was a free bypass. Default
// deny; a genuine click-through child uses the opt-out comment.
const ACTION_TARGET = /\.action-(panel|btn|button|buttons|bar|controls|row)(?![a-z0-9])/i;
const OPT_OUT = /allow-pointer-events-lockout/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(css|scss|tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const violations = [];
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

for (const file of walk(SRC)) {
  const raw = readFileSync(file, 'utf8');
  const rel = relative(root, file);

  // ── CSS rules ──────────────────────────────────────────────────────────────
  if (/\.(css|scss)$/.test(file)) {
    // Blank out comments but preserve offsets, so reported line numbers are
    // exact and a commented-out example cannot trip the check.
    const clean = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    const RULE = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = RULE.exec(clean)) !== null) {
      const selector = m[1].trim().replace(/\s+/g, ' ');
      const body = m[2];
      if (!ALLIN.test(selector)) continue;

      const pe = /pointer-events\s*:\s*([^;}]+)/i.exec(body);
      if (!pe) continue;
      const value = pe[1].trim();
      // `auto`, and any custom property whose fallback keeps it interactive.
      if (/^auto$/i.test(value)) continue;
      if (/^var\(/i.test(value)) continue;

      // A pseudo-element cannot swallow a click meant for a real element; this
      // is the click-through fix, not the bug.
      if (/::(before|after|backdrop)/.test(selector)) continue;
      // Explicitly excluding the panel is the opposite of the defect.
      if (/:not\([^)]*action-/.test(selector)) continue;

      // Two ways to kill the buttons: name them, or name an ancestor and let
      // inheritance do it. The bare mode root is the ancestor of everything.
      const namesTarget = ACTION_TARGET.test(selector);
      const isModeRoot = /^\.?[\w-]*allin-mode[\w-]*$/i.test(selector.replace(/^\./, '.'));
      if (!namesTarget && !isModeRoot) continue;

      // The match starts at the character after the previous rule's `}`, i.e.
      // in the whitespace/comment gap — NOT at the selector. Using m.index
      // directly reported a line 1-3 above the real one and made the opt-out
      // lookback search the wrong lines entirely.
      const selStart = m.index + (m[1].length - m[1].trimStart().length);
      const line = lineOf(clean, selStart);
      const lines = raw.split('\n');
      // The selector line itself plus the three above it (trailing or leading
      // comment both work).
      const context = lines.slice(Math.max(0, line - 4), line).join('\n');
      if (OPT_OUT.test(context)) continue;

      violations.push({
        file: rel,
        line,
        selector,
        value,
        why: isModeRoot
          ? 'pointer-events is inherited — setting it on the all-in mode root disables every descendant, including the action buttons'
          : 'this selector targets the hero action controls',
      });
    }
  }

  // ── Inline React styles ────────────────────────────────────────────────────
  if (/\.tsx?$/.test(file)) {
    const RE = /pointerEvents\s*:\s*([^,}\n]+)/g;
    let m;
    while ((m = RE.exec(raw)) !== null) {
      const expr = m[1];
      if (!/['"]none['"]/.test(expr)) continue;
      // Only when the value is decided by all-in state. An unconditional
      // pointerEvents:'none' on a decorative element is not this bug.
      if (!ALLIN.test(expr)) continue;
      const line = lineOf(raw, m.index);
      const context = raw.split('\n').slice(Math.max(0, line - 4), line).join('\n');
      if (OPT_OUT.test(context)) continue;
      violations.push({
        file: rel,
        line,
        selector: `inline style: pointerEvents: ${expr.trim()}`,
        value: 'none',
        why: 'input is disabled as a function of all-in state, in JSX where no CSS guard can see it',
      });
    }
  }
}

if (violations.length) {
  console.error('');
  console.error('FAIL: all-in mode must never take pointer events away from the action controls.');
  console.error('      This is the defect that made Call/Fold dead while facing an all-in');
  console.error('      (production hand #1315, 30.1s to a forced fold).');
  console.error('');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.selector}  ->  pointer-events: ${v.value}`);
    console.error(`    ${v.why}`);
    console.error('');
  }
  console.error('  Dim with opacity/filter instead. Never take away input.');
  console.error('  If this really is a click-through overlay, put');
  console.error('    /* allow-pointer-events-lockout: <reason> */');
  console.error('  on the line above so the reason lands in the diff.');
  console.error('');
  process.exit(1);
}

console.log('OK: all-in mode never disables pointer events on the hero action controls');
