#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * check-rake-schedule-parity.mjs — the rake schedule exists twice; keep it honest
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS
 *
 * The rake schedule is declared in two places that cannot import each other,
 * because the client and the engine are separate builds:
 *
 *   server/src/config/rakeSpec.ts     SCHEDULE       <- AUTHORITATIVE. What is
 *                                                       actually taken from pots.
 *                                                       (Until 2026-09-02 this
 *                                                       literal lived in
 *                                                       server/src/config/RakeConfig.ts
 *                                                       as RAKE_SCHEDULE; that file
 *                                                       now re-exports RAKE_SPEC.schedule
 *                                                       and holds no literal, so an
 *                                                       anchor on RAKE_SCHEDULE there
 *                                                       reads the type annotation's
 *                                                       `[]` and parses garbage.)
 *   src/config/RakeConfig.ts          RAKE_SCHEDULE  <- what players are SHOWN
 *                                                       in the Game Rules modal.
 *
 * On 2026-08-15 the Game Rules modal was found to be telling every player
 * "Rake 5% (Cap $3)" at every stake, because the props feeding it were never
 * assigned and the component fell through to its placeholder defaults. The real
 * rake is 10% with tier caps up to $15 — at 10/25 we understated the cap
 * five-fold. The display now reads from the client copy of the schedule.
 *
 * That fix holds only while the two copies agree. If someone edits the server
 * schedule and forgets the client one, we quietly start misstating the rake
 * again — the exact failure just repaired, in a form nobody would notice. This
 * check fails the build in that case.
 *
 * Entries are compared structurally, not as text, so comments, key ordering and
 * formatting differences do not matter.
 *
 * Usage:  node scripts/ci/check-rake-schedule-parity.mjs
 * Exit 0 = schedules agree. Exit 1 = drift (build should fail).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');

const CLIENT = resolve(REPO, 'src/config/RakeConfig.ts');
const SERVER = resolve(REPO, 'server/src/config/rakeSpec.ts');

/**
 * Pull the RAKE_SCHEDULE array literal out of a TS source file and parse each
 * `{ sb, bb, rakePercent, rakeCap, bbjFeeBB }` entry into a plain object.
 * Deliberately regex-based: this must run in CI with no build step and no
 * TypeScript loader, against both the client and the server config.
 */
function extractSchedule(file, anchor) {
  const src = readFileSync(file, 'utf8');
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error(`${anchor} not found in ${file}`);
  // The literal's own `= [`, never the `[]` of a type annotation.
  const open = src.indexOf('= [', start);
  const close = src.indexOf('];', open);
  if (open === -1 || close === -1) throw new Error(`Could not bound RAKE_SCHEDULE in ${file}`);
  const body = src.slice(open, close);

  const entries = [];
  for (const m of body.matchAll(/\{([^}]*)\}/g)) {
    const row = {};
    for (const f of m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(-?[\d.]+)/g)) {
      row[f[1]] = Number(f[2]);
    }
    if (Object.keys(row).length > 0) entries.push(row);
  }
  if (entries.length === 0) throw new Error(`Parsed zero RAKE_SCHEDULE entries from ${file}`);
  return entries;
}

const FIELDS = ['sb', 'bb', 'rakePercent', 'rakeCap', 'bbjFeeBB'];
const key = (e) => `${e.sb}/${e.bb}`;
const fmt = (e) => FIELDS.map((f) => `${f}=${e[f]}`).join(' ');

let client, server;
try {
  client = extractSchedule(CLIENT, 'RAKE_SCHEDULE');
  server = extractSchedule(SERVER, 'const SCHEDULE');
} catch (err) {
  console.error(`\nRAKE SCHEDULE PARITY: could not read a schedule.\n  ${err.message}\n`);
  process.exit(1);
}

const problems = [];

if (client.length !== server.length) {
  problems.push(`entry count differs — client ${client.length}, server ${server.length}`);
}

const serverByKey = new Map(server.map((e) => [key(e), e]));
const clientByKey = new Map(client.map((e) => [key(e), e]));

for (const [k, s] of serverByKey) {
  const c = clientByKey.get(k);
  if (!c) {
    problems.push(
      `stake ${k} exists on the SERVER but not the client — players see no entry for a stake we rake`
    );
    continue;
  }
  for (const f of FIELDS) {
    if (c[f] !== s[f]) {
      problems.push(
        `stake ${k}: ${f} client=${c[f]} server=${s[f]}  (server is what is actually taken)`
      );
    }
  }
}
for (const k of clientByKey.keys()) {
  if (!serverByKey.has(k)) {
    problems.push(
      `stake ${k} exists on the CLIENT but not the server — we would advertise a rake we never take`
    );
  }
}

if (problems.length > 0) {
  console.error('\n═══════════════════════════════════════════════════════════════');
  console.error('  RAKE SCHEDULE DRIFT — the rake shown to players would be wrong');
  console.error('═══════════════════════════════════════════════════════════════\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  client: ${CLIENT.replace(REPO + '/', '')}`);
  console.error(`  server: ${SERVER.replace(REPO + '/', '')}  <- authoritative\n`);
  console.error('  These two must stay identical. The server value is what is');
  console.error('  actually removed from the pot; the client value is what the');
  console.error('  Game Rules modal tells the player. If they differ, we are');
  console.error('  misstating the rake.\n');
  process.exit(1);
}

console.log(`RAKE SCHEDULE PARITY: OK — ${server.length} stakes identical on client and server.`);
for (const e of server) console.log(`  ${fmt(e)}`);
