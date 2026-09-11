/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE QUALIFYING RULE PER VARIANT - THE ENGINE'S, STATED NOWHERE ELSE
 *  BBJ programme phase 4 of 5 (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `BBJ_QUALIFYING_HANDS` decides which hand wins a jackpot. It exists TWICE -
 * `server/src/config/RakeConfig.ts`, which the engine enforces, and
 * `src/config/RakeConfig.ts`, which every player-facing surface reads. Two
 * copies of a money rule, maintained by hand, with nothing comparing them.
 *
 * They had drifted, and it reached players. The server carried a `pineapple`
 * entry - Quad Kings or better must lose - and the client did not.
 * `normalizeVariantKey` falls through to `'nlh'` for any key it does not
 * recognise, so every Pineapple table showed the HOLD'EM bar: aces full or
 * better, plus the Ace-in-the-hole and both-cards-play rules. Measured on
 * production 2026-09-11: 293 Pineapple tables, 11,606 BBJ-raked hands in
 * seven days, FOUR jackpot hits already paid under the rule the client was
 * not showing. A player holding aces full there was reading a qualifying hand
 * that does not qualify, and the mini inherited the same mistake, because
 * `miniRuleForVariantKey` picks its family from this constant's `handRank`.
 *
 * A third copy exists in the database - `public.bbj_qualifying_hands` - and it
 * is read by nothing at all (the only references in the tree are a cleanup
 * DELETE and a GRANT revoke). It disagreed with both code halves: it marked
 * PLO6 ELIGIBLE, which both halves refuse; it carried an `ofc` row neither has;
 * and it was missing five variants including the live `pineapple`. A table that
 * looks authoritative and is not is worse than no table.
 *
 * So: the two code halves must be IDENTICAL, field for field. This law is the
 * only thing that makes that true.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Pull the constant out of either half as comparable JSON. */
function qualifyingHands(file: string): Record<string, Record<string, unknown>> {
  const src = read(file);
  const start = src.indexOf('export const BBJ_QUALIFYING_HANDS');
  expect(start, `${file} must declare BBJ_QUALIFYING_HANDS`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n};', start));

  const out: Record<string, Record<string, unknown>> = {};
  const keyRe = /^ {2}([a-z_0-9]+): \{$/gm;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(body)) !== null) {
    const key = m[1];
    const entry = body.slice(m.index, body.indexOf('\n  },', m.index));
    const field = (name: string): unknown => {
      const str = entry.match(new RegExp(`${name}: '((?:[^'\\\\]|\\\\.)*)'`));
      if (str) return str[1];
      const lit = entry.match(new RegExp(`${name}: (null|true|false)`));
      if (lit) return lit[1] === 'null' ? null : lit[1] === 'true';
      return undefined;
    };
    out[key] = {
      label: field('label'),
      minLosingHand: field('minLosingHand'),
      description: field('description'),
      handRank: field('handRank'),
      minRankValue: field('minRankValue'),
      eligible: field('eligible'),
      rules: [...entry.matchAll(/^ {6}'((?:[^'\\]|\\.)*)',$/gm)].map((r) => r[1]),
    };
  }
  return out;
}

const CLIENT = 'src/config/RakeConfig.ts';
const SERVER = 'server/src/config/RakeConfig.ts';

describe('the client states the rule the engine enforces, for every variant', () => {
  const client = qualifyingHands(CLIENT);
  const server = qualifyingHands(SERVER);

  it('parses a real constant from both halves', () => {
    expect(Object.keys(client).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(server).length).toBeGreaterThanOrEqual(10);
  });

  it('covers exactly the same variants on both sides', () => {
    // Pineapple was on the server and not the client for months.
    expect(Object.keys(client).sort()).toEqual(Object.keys(server).sort());
  });

  it('states the same bar, rank, eligibility and wording for every variant', () => {
    for (const key of Object.keys(server).sort()) {
      expect(client[key], `${key} is missing from ${CLIENT}`).toBeDefined();
      expect({ variant: key, ...client[key] }).toEqual({ variant: key, ...server[key] });
    }
  });

  it('pineapple is present, eligible, and is NOT the hold-em bar', () => {
    for (const [half, map] of [
      ['client', client],
      ['server', server],
    ] as const) {
      const p = map.pineapple;
      expect(p, `pineapple missing from the ${half}`).toBeDefined();
      expect(p.eligible, `pineapple must not be marked ineligible (${half})`).not.toBe(false);
      expect(p.handRank, `pineapple is quads, not a boat (${half})`).toBe('four_of_a_kind');
      expect(p.minLosingHand, `pineapple bar (${half})`).toBe('KKKK2');
      // the mini reads handRank; hold'em's boat would give it the wrong family
      expect(p.handRank).not.toBe('full_house');
    }
  });

  it('an unknown variant cannot be silently resolved to a DIFFERENT rule', () => {
    /* normalizeVariantKey returns 'nlh' for anything it does not recognise,
       which is what turned Pineapple into hold'em. That fallback is only safe
       while every variant the platform actually spreads has its own key, so
       the live list is pinned here: adding a variant to the platform without
       adding it here is the bug, and this is where it is caught. */
    const LIVE_VARIANTS = [
      'nlh',
      'flh',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
      'flo8',
      'short_deck',
      'pineapple',
    ];
    for (const v of LIVE_VARIANTS) {
      expect(client[v], `${v} is spread on production and needs its own entry`).toBeDefined();
    }
  });

  it('the client normalizer resolves every live variant to ITSELF, never to a fallback', () => {
    const src = read(CLIENT);
    // the first branch of normalizeVariantKey is the identity branch
    expect(src).toMatch(/if \(BBJ_QUALIFYING_HANDS\[raw\]\) return raw;/);
  });
});
