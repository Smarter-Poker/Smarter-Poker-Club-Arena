#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  check-rake-bbj-collection-law — the fee is priced ONCE, and never by pot size
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-29, BINDING:
 *   "POT DOESN'T NEED TO BE 10 BB FOR THE BBJ TO BE TAKEN OUT... IF THERE IS
 *    A FLOP, BBJ SHOULD BE RAKED (3 OR MORE PLAYERS DEALT INTO THE HAND).
 *    BAD BEAT JACKPOT IS ONLY PAID OUT IF THERE IS MORE THEN 10 BB IN THE
 *    POT... BIG DIFFERENCE."
 *   "harden the rake and bbj process collection and tracking so it can't
 *    regress or break ever."
 *
 * ── WHY A GATE ─────────────────────────────────────────────────────────────
 *
 * The bug this prevents was not subtle and it still survived for months:
 * every BBJ FEE site also required `potInBB >= minPotBB`, which is the PAYOUT
 * rule. 5,051 of 10,267 raked hands (49%) paid rake and fed the jackpot
 * NOTHING. It survived because the arithmetic was hand-copied into three
 * settlement paths, so no single place looked wrong — and the same copying
 * had already produced a second bug: finalizeRunout was missing the
 * pot-overage clamp the other two had, so a small RIT pot could be charged
 * more than it held and mint chips.
 *
 * A unit test proves today's code is right. This gate proves TOMORROW'S is:
 * it fails the build if anyone re-introduces a pot-size condition on a fee
 * path, or adds a fourth hand-rolled copy of the pricing.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 *   1. HandController prices deductions in exactly ONE function
 *      (priceDeductions). `bbjCfg.feeBB` may be multiplied out exactly once
 *      in the whole file.
 *   2. No fee path may mention minPotBB / potInBB. That threshold belongs to
 *      detectBBJHit (payout) in RakeConfig, and nowhere else.
 *   3. calculateBBJFee (both repo copies) takes flopSeen, never potSize.
 *
 * Deliberately changing the law? Change it here IN THE SAME COMMIT and say so
 * in the PR — same contract as every other law gate in this repo.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => (existsSync(resolve(REPO, p)) ? readFileSync(resolve(REPO, p), 'utf8') : null);
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const failures = [];

// ── 1 + 2. The engine: one pricer, no pot gate on the fee ──────────────────
const hcPath = 'server/src/engine/HandController.ts';
const hcRaw = read(hcPath);
if (!hcRaw) {
  failures.push(`${hcPath} not found — the fee pricer must live there.`);
} else {
  const hc = strip(hcRaw);

  if (!/public priceDeductions\s*\(/.test(hc)) {
    failures.push(
      `${hcPath}: priceDeductions() is gone. It is the ONE place rake and the BBJ drop are priced; ` +
        `every settlement path must call it.`
    );
  }

  const feeSites = hc.match(/bbjCfg\.feeBB|bbjConfig\.feeBB/g) ?? [];
  if (feeSites.length > 1) {
    failures.push(
      `${hcPath}: the BBJ fee is multiplied out ${feeSites.length} times. It must be exactly ONCE, ` +
        `inside priceDeductions(). Three hand-copies is how the 49%-underfunded-jackpot bug and the ` +
        `missing pot-overage clamp both shipped.`
    );
  }

  for (const token of ['minPotBB', 'potInBB']) {
    if (new RegExp(`\\b${token}\\b`).test(hc)) {
      failures.push(
        `${hcPath}: mentions ${token}. Pot size NEVER gates the BBJ fee — it gates the PAYOUT ` +
          `(detectBBJHit in config/RakeConfig.ts). Collection = flop + 3+ players dealt in.`
      );
    }
  }

  const routed = (hc.match(/this\.priceDeductions\s*\(/g) ?? []).length;
  if (routed < 3) {
    failures.push(
      `${hcPath}: only ${routed} call(s) to priceDeductions(). completeHand, finalizeRunout and ` +
        `computeRakeAndBBJ must all route through it.`
    );
  }
}

// ── 3. Both calculateBBJFee copies take flopSeen, not potSize ──────────────
for (const p of ['server/src/config/RakeConfig.ts', 'src/config/RakeConfig.ts']) {
  const raw = read(p);
  if (!raw) continue;
  const m = strip(raw).match(/export function calculateBBJFee\s*\(([\s\S]*?)\)\s*:/);
  if (!m) {
    failures.push(`${p}: calculateBBJFee not found.`);
    continue;
  }
  const params = m[1];
  if (/potSize/.test(params)) {
    failures.push(
      `${p}: calculateBBJFee still takes potSize. The collection rule does not look at the pot — ` +
        `take flopSeen instead (Dan 2026-08-29).`
    );
  }
  if (!/flopSeen/.test(params)) {
    failures.push(`${p}: calculateBBJFee must take flopSeen — the drop is owed on every flop.`);
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('\ncheck-rake-bbj-collection-law FAILED:\n');
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error(
    '  THE LAW (Dan 2026-08-29): the BBJ drop is COLLECTED on every flop with 3+ players\n' +
      '  dealt in, whatever the pot size. The 10BB minimum decides whether a bad beat is\n' +
      '  PAID OUT. Rake + drop may never exceed the pot. All of it is priced in exactly one\n' +
      '  function: HandController.priceDeductions().\n'
  );
  process.exit(1);
}

console.log(
  'check-rake-bbj-collection-law: OK - one pricer, no pot gate on the fee, flopSeen everywhere.'
);
