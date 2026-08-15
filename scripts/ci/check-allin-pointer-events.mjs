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
 * engine was completely healthy the entire time.
 *
 * The cause was one CSS declaration:
 *
 *     .table-page--allin-mode .action-panel { pointer-events: none; }
 *
 * The intent was to visually de-emphasise the panel during the all-in runout.
 * The effect was that every click was swallowed before it reached React. No
 * unit test, no integration test, and no engine assertion can catch this — the
 * handler is wired correctly and would fire if it ever received the event.
 * The only durable defence is to assert the declaration never comes back.
 *
 * Rule: `.table-page--allin-mode` rule blocks that target the action panel may
 * change opacity, filter, transition — anything visual — but must never set
 * `pointer-events` to anything other than `auto`.
 *
 * Dimming is fine. Dimming is not the bug. Swallowing input is the bug.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = resolve(root, 'src/pages/TablePage.css');

let src;
try {
  src = readFileSync(CSS, 'utf8');
} catch {
  console.error(`FAIL: cannot read ${CSS}`);
  process.exit(1);
}

// Strip comments so a commented-out example cannot trip the check.
const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');

const violations = [];

// Walk every rule block: `<selector> { <body> }`
const RULE = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = RULE.exec(clean)) !== null) {
  const selector = m[1].trim().replace(/\s+/g, ' ');
  const body = m[2];

  const touchesAllin = selector.includes('allin-mode');
  const touchesPanel = /\.action-panel|\.action-buttons|\.action-bar/.test(selector);
  if (!touchesAllin || !touchesPanel) continue;

  const pe = /pointer-events\s*:\s*([a-z-]+)/i.exec(body);
  if (pe && pe[1].toLowerCase() !== 'auto') {
    // Recover a line number for a useful error message.
    const idx = clean.indexOf(m[0]);
    const line = clean.slice(0, idx).split('\n').length;
    violations.push({ selector, value: pe[1], line });
  }
}

if (violations.length > 0) {
  console.error('');
  console.error('FAIL: all-in mode must never disable pointer events on the action panel.');
  console.error('      This is the exact defect that made Call/Fold dead while facing an');
  console.error('      all-in (production hand #1315, 30.1s to a forced fold).');
  console.error('');
  for (const v of violations) {
    console.error(`  src/pages/TablePage.css:${v.line}`);
    console.error(`    ${v.selector} { ... pointer-events: ${v.value} ... }`);
  }
  console.error('');
  console.error('  Dim the panel with opacity/filter instead. Never take away input.');
  console.error('');
  process.exit(1);
}

console.log('OK: no pointer-events lockout on the action panel in all-in mode');
