#!/usr/bin/env node
/**
 * BLOCKING. The cash seat law is declared twice and must agree.
 *
 * Dan's law — plo6 6, plo5 7, plo4 8, plo8 8, everything else 9 — lives in
 * src/config/tableSeating.ts for the client and server/src/config/tableSeating.ts
 * for the engine. They cannot share a module: server/tsconfig.json sets
 * rootDir './src', so importing across the boundary would change the compiled
 * layout of a live engine. This is the same shape as the rake schedule, and
 * gets the same treatment — declared twice, and CI fails if they disagree.
 *
 * It also checks the one place the engine acts on the law:
 * HorseFleetManager.DEFAULT_TABLES, which creates the fleet's cash tables. On
 * 2026-08-19 that array said PLO5 8-max and PLO6 7-max while the law said 7
 * and 6, and it had been putting illegal tables into production on every boot
 * — the client guard never saw them because it only guards the club's Create
 * Table modal. A seat count in that array above the law fails this check even
 * though the insert now clamps, because a clamped config is a lie in the file.
 *
 * Deck arithmetic is what makes it matter: PokerEngine.deal() THROWS
 * 'Not enough cards in deck' rather than dealing short, so an over-seated PLO
 * table does not degrade — it fails mid-hand when Run It Twice asks for boards
 * the deck cannot supply.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const CLIENT = 'src/config/tableSeating.ts';
const SERVER = 'server/src/config/tableSeating.ts';
const FLEET = 'server/src/services/HorseFleetManager.ts';

const read = (rel) => {
  try {
    return readFileSync(join(REPO, rel), 'utf8');
  } catch {
    console.error(`FAIL: ${rel} is missing. The seat law must exist in both places.`);
    process.exit(1);
  }
};

/** Parse the MAX_SEATS_BY_VARIANT literal out of a tableSeating module. */
function parseLaw(src, rel) {
  const block = /MAX_SEATS_BY_VARIANT[^=]*=\s*\{([\s\S]*?)\}/.exec(src);
  if (!block) {
    console.error(`FAIL: could not find MAX_SEATS_BY_VARIANT in ${rel}.`);
    process.exit(1);
  }
  const law = {};
  for (const m of block[1].matchAll(/(\w+)\s*:\s*(\d+)/g)) law[m[1]] = Number(m[2]);
  if (Object.keys(law).length === 0) {
    console.error(`FAIL: MAX_SEATS_BY_VARIANT in ${rel} parsed as empty.`);
    process.exit(1);
  }
  const def = /DEFAULT_MAX_SEATS\s*=\s*(\d+)/.exec(src);
  if (!def) {
    console.error(`FAIL: could not find DEFAULT_MAX_SEATS in ${rel}.`);
    process.exit(1);
  }
  return { law, fallback: Number(def[1]) };
}

const client = parseLaw(read(CLIENT), CLIENT);
const server = parseLaw(read(SERVER), SERVER);

const problems = [];

if (client.fallback !== server.fallback) {
  problems.push(
    `DEFAULT_MAX_SEATS differs: client ${client.fallback}, server ${server.fallback}`
  );
}

const variants = [...new Set([...Object.keys(client.law), ...Object.keys(server.law)])].sort();
for (const v of variants) {
  const c = client.law[v];
  const s = server.law[v];
  if (c === undefined) problems.push(`${v}: missing from ${CLIENT} (server says ${s})`);
  else if (s === undefined) problems.push(`${v}: missing from ${SERVER} (client says ${c})`);
  else if (c !== s) problems.push(`${v}: client says ${c}, server says ${s}`);
}

// ── The engine's own table configs must obey the law they now import ────────
const fleet = read(FLEET);
const configBlock = /DEFAULT_TABLES:\s*TableConfig\[\]\s*=\s*\[([\s\S]*?)\n\];/.exec(fleet);
if (!configBlock) {
  console.error(`FAIL: could not find DEFAULT_TABLES in ${FLEET}.`);
  process.exit(1);
}
const entries = [
  ...configBlock[1].matchAll(
    /name:\s*'([^']+)'[\s\S]*?maxPlayers:\s*(\d+)[\s\S]*?gameVariant:\s*'([^']+)'/g
  ),
];
if (entries.length === 0) {
  console.error(`FAIL: DEFAULT_TABLES in ${FLEET} parsed as empty — the guard would pass blind.`);
  process.exit(1);
}
for (const [, name, seats, variant] of entries) {
  const cap = client.law[variant.toLowerCase()] ?? client.fallback;
  if (Number(seats) > cap) {
    problems.push(`${FLEET}: "${name}" seats ${seats}, but ${variant} is ${cap}-max`);
  }
}

if (problems.length > 0) {
  console.error('SEAT LAW MISMATCH:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nThe law is one number per variant, CASH ONLY. Fix ${CLIENT}, ${SERVER} and\n` +
      `${FLEET} together. Tournament tables are exempt and must not be routed\n` +
      `through it — see the header of ${CLIENT}.`
  );
  process.exit(1);
}

const shown = variants.map((v) => `${v}=${client.law[v]}`).join(' ');
console.log(
  `check-seat-law-parity: client and server agree — ${shown} default=${client.fallback}; ` +
    `${entries.length} fleet table config(s) within the law.`
);
