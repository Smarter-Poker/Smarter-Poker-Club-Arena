#!/usr/bin/env node
/**
 * RAKE CONFIG PARITY — client STAKES_TIERS must equal server STAKES_TIERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * There are two copies of the stakes ladder in this repo:
 *
 *   server/src/config/RakeConfig.ts   the AUTHORITY. The engine charges the BBJ
 *                                     fee from it, caps rake from it, and
 *                                     derives the payout percent it hands to
 *                                     bbj_atomic_payout_v2.
 *   src/config/RakeConfig.ts          the client's copy, used to TELL a player
 *                                     what they will be charged and paid.
 *
 * On 2026-08-23 they disagreed on four of six tiers, and had done for long
 * enough that a comment in the client file described the drift as a known
 * quantity instead of fixing it. Concretely: a 0.2/0.4 game was Nano to the
 * client and Micro to the server, and Micro's BBJ fee was published as 0.25bb
 * while 0.60bb was charged.
 *
 * A comment cannot hold two files together. This can.
 *
 * Compares the fields that decide money — the tier window, the rake percent and
 * cap, the BBJ fee, and the payout percent — plus the boundary cascade in
 * getTierForBB / getStakesTierForBB, which is what actually selects the tier.
 *
 *   exit 0 = the two agree
 *   exit 1 = they do not, printed field by field
 */

import { readFileSync } from 'node:fs';

const CLIENT = 'src/config/RakeConfig.ts';
const SERVER = 'server/src/config/RakeConfig.ts';

const TIERS = ['nano', 'micro', 'small', 'mid', 'high', 'nosebleeds'];
/** Only fields that decide money. `label` and `blindRange` are prose. */
const FIELDS = [
  'minBB',
  'maxBB',
  'rakePercent',
  'rakeCap',
  'rakeCapBB',
  'bbjFeeBB',
  'bbjPayoutTotalPercent',
];

/** Pull `STAKES_TIERS` out of a file by brace-matching, then read each tier. */
function parseTiers(path) {
  const src = readFileSync(path, 'utf8');
  const anchor = src.indexOf('STAKES_TIERS');
  if (anchor < 0) throw new Error(`${path}: no STAKES_TIERS`);
  const open = src.indexOf('{', anchor);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) throw new Error(`${path}: unterminated STAKES_TIERS`);
  const body = src.slice(open, end + 1);

  const out = {};
  for (const tier of TIERS) {
    const tAt = body.indexOf(`${tier}:`);
    if (tAt < 0) continue;
    const tOpen = body.indexOf('{', tAt);
    let d = 0;
    let tEnd = -1;
    for (let i = tOpen; i < body.length; i++) {
      if (body[i] === '{') d++;
      else if (body[i] === '}') {
        d--;
        if (d === 0) {
          tEnd = i;
          break;
        }
      }
    }
    const chunk = body.slice(tOpen, tEnd + 1);
    const vals = {};
    for (const f of FIELDS) {
      const m = chunk.match(new RegExp(`\\b${f}\\s*:\\s*([A-Za-z0-9_.+-]+)`));
      vals[f] = m ? (m[1] === 'Infinity' ? Infinity : Number(m[1])) : undefined;
    }
    out[tier] = vals;
  }
  return out;
}

/**
 * The `<= X` ladder that selects a tier. This is what actually decides which
 * tier a table is in, so it is compared independently of the tier table.
 *
 * Both files name the function getTierForBB; the client's parameter is `bb`
 * and the server's is `bigBlind`, so the identifier is matched loosely rather
 * than assumed.
 */
function parseCascade(path) {
  const src = readFileSync(path, 'utf8');
  const at = src.indexOf('function getTierForBB');
  if (at < 0) throw new Error(`${path}: no getTierForBB`);
  const body = src.slice(at, at + 1500);
  const steps = [
    ...body.matchAll(/\b\w+\s*<=\s*([0-9.]+)\s*\)\s*return\s+STAKES_TIERS\.(\w+)/g),
  ].map((m) => `${m[2]}<=${m[1]}`);
  if (steps.length === 0) throw new Error(`${path}: getTierForBB has no cascade`);
  return steps;
}

const client = parseTiers(CLIENT);
const server = parseTiers(SERVER);

const problems = [];
for (const tier of TIERS) {
  const c = client[tier];
  const s = server[tier];
  if (!c) {
    problems.push(`${tier}: missing from ${CLIENT}`);
    continue;
  }
  if (!s) {
    problems.push(`${tier}: missing from ${SERVER}`);
    continue;
  }
  for (const f of FIELDS) {
    if (c[f] === undefined) {
      problems.push(`${tier}.${f}: absent in client`);
      continue;
    }
    if (s[f] === undefined) {
      problems.push(`${tier}.${f}: absent in server`);
      continue;
    }
    if (c[f] !== s[f]) {
      problems.push(`${tier}.${f}: client ${c[f]} !== server ${s[f]}`);
    }
  }
}

const cCascade = parseCascade(CLIENT);
const sCascade = parseCascade(SERVER);
if (cCascade.join(' ') !== sCascade.join(' ')) {
  problems.push(
    `tier cascade differs:\n    client: ${cCascade.join(' ')}\n    server: ${sCascade.join(' ')}`
  );
}

console.log(`[check-rakeconfig-parity] tiers compared: ${TIERS.length}`);
console.log(`[check-rakeconfig-parity] cascade steps: ${sCascade.length}`);

if (problems.length > 0) {
  console.error('\nRAKE CONFIG DRIFT DETECTED');
  console.error(`(${CLIENT} disagrees with ${SERVER}, which is what the engine uses)\n`);
  for (const p of problems) console.error(`  ${p}`);
  console.error('\nThe server file is the authority. Change the client to match it,');
  console.error('and update bbj_stakes_tiers in the same PR so the published');
  console.error('mirror the jackpot panel reads does not fall behind either.\n');
  process.exit(1);
}

console.log('client and server rake config agree');
