#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BUS WIRING GATE — a listener with no emitter is a feature that cannot fire
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sibling to check-phantom-tables.mjs. That gate catches a `.from()` pointing
 * at nothing; this one catches a `masterBus.subscribe()` pointing at nothing.
 *
 * WHY THIS EXISTS
 *
 * On 2026-08-20 an audit found 22 event names that something LISTENS for and
 * nothing EMITS. Each is a component wired up, styled, shipped — and dead.
 * HoleCardReveal waits for SHOWDOWN_START. MilestoneToast waits for
 * MILESTONE_UNLOCKED. TournamentClock waits for four different break events.
 * None of them has ever fired, and nothing in the build said so, because a
 * subscription to an event nobody sends is perfectly valid code.
 *
 * The codebase already knew this shape of bug: TablePage carries a comment
 * headed "DEAD-WIRING FIX 2026-08-15: heads-up never announced either", where
 * HEADS_UP_SWITCH turned out to have "zero callers". It was found by hand,
 * months late. This gate finds the rest of them in two seconds.
 *
 * DETECTION
 *
 * Deliberately PERMISSIVE on the emitter side, matching check-stranded-writers:
 * any `emit('NAME'` anywhere in src/ or server/src counts, including through a
 * constant. A false red on a real feature is far more expensive than missing
 * one dead listener, because a gate people distrust gets switched off.
 *
 * USAGE
 *   node scripts/ci/check-bus-wiring.mjs          # strict (exit 1)
 *   node scripts/ci/check-bus-wiring.mjs --warn   # advisory (always exit 0)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['src', 'server/src'];
const ALLOWLIST_PATH = 'scripts/ci/bus-wiring.allowlist.json';
const WARN_ONLY = process.argv.includes('--warn');

/** Every .ts/.tsx under the roots, skipping build output and tests. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

// A listener: masterBus.subscribe('X') or useMasterBusSubscription('X').
const LISTEN = /(?:masterBus\.subscribe|useMasterBusSubscription)\(\s*['"]([A-Z0-9_]+)['"]/g;
// An emitter: any .emit('X') — masterBus, a local bus, a re-export. Permissive.
const EMIT = /\.emit\(\s*['"]([A-Z0-9_]+)['"]/g;

const listeners = new Map(); // NAME -> [{file, line}]
const emitted = new Set();

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;

  for (const m of text.matchAll(LISTEN)) {
    const name = m[1];
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push({ file: relative(process.cwd(), file), line: lineAt(m.index) });
  }
  for (const m of text.matchAll(EMIT)) emitted.add(m[1]);
}

let allow = {};
try {
  allow = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
} catch {
  /* no allowlist yet — every dead listener is reported */
}
const allowed = new Set(Object.keys(allow).filter((k) => !k.startsWith('_')));

const dead = [...listeners.keys()].filter((n) => !emitted.has(n) && !allowed.has(n)).sort();

console.log(
  `[check-bus-wiring] ${listeners.size} listened events, ${emitted.size} emitted · allowlisted: ${allowed.size}`
);

if (dead.length === 0) {
  console.log('[check-bus-wiring] OK — every listener has at least one emitter.');
  process.exit(0);
}

console.log(`\nDEAD LISTENERS DETECTED (${dead.length}) — subscribed, never emitted:\n`);
for (const name of dead) {
  console.log(`  ${name}`);
  for (const { file, line } of listeners.get(name)) console.log(`    ${file}:${line}`);
}
console.log(`
Fix a dead listener:
  1. The feature SHOULD fire -> emit the event where it happens.
  2. The name is wrong -> correct it to the event that is actually emitted.
  3. It is an engine not yet ported (see MIGRATION-LAW.md) or a deliberate
     unbuilt feature -> add it, WITH A REASON, to ${ALLOWLIST_PATH}.
`);

process.exit(WARN_ONLY ? 0 : 1);
