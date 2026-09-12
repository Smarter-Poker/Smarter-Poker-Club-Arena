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

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT THE POST-PHASE AUDIT FOUND (2026-09-11)

   Unifying the two constants fixed the BAR and left four surfaces stating the
   rule around it. Every pin below is a wrong sentence that reached a player.
   ═══════════════════════════════════════════════════════════════════════════ */
describe('the rule AROUND the bar is right too, on every live variant', () => {
  it('the client states the same players-dealt floor the engine enforces', () => {
    /* The client said 4 and the engine has paid at 3 since FIX 145, so every
       rules surface told a three-handed table it could not win a jackpot it
       was in fact eligible for. Dan, 2026-09-11: "BBJ ONLY NEEDS 3 PLAYERS FOR
       THE RECORD." */
    const client = read('src/config/RakeConfig.ts');
    const spec = read('server/src/config/rakeSpec.ts');
    const clientN = client.match(/^\s*minPlayersDealt: (\d+),/m)?.[1];
    const serverN = spec.match(/^\s*bbjMinPlayersDealt: (\d+),/m)?.[1];
    expect(serverN, 'the engine floor').toBe('3');
    expect(clientN, 'the client must state the engine floor').toBe(serverN);
  });

  it('the sub-label is chosen by the RANK, never by how the key is spelled', () => {
    /* `key.startsWith('plo')` handed pineapple and flo8 the hold'em sentence -
       "with an Ace for the full house" - under a Quad Kings bar. */
    const src = read('src/config/RakeConfig.ts');
    expect(src).not.toMatch(/const isOmaha = key\.startsWith\('plo'\);/);
    expect(src).toMatch(/const isFullHouseBar = q\.handRank === 'full_house';/);
    expect(src).toMatch(/key\.startsWith\('plo'\) \|\| key\.startsWith\('flo'\)/);
  });

  it('every eligible variant has a short label, so none falls through to SHOUTY prose', () => {
    const src = read('src/config/RakeConfig.ts');
    const labels = src.slice(
      src.indexOf('BBJ_SHORT_LABELS'),
      src.indexOf('};', src.indexOf('BBJ_SHORT_LABELS'))
    );
    const hands = qualifyingHands(CLIENT);
    for (const [key, entry] of Object.entries(hands)) {
      if (entry.eligible === false) continue;
      expect(labels, `${key} needs a short label`).toContain(`${key}:`);
    }
  });

  it('every eligible variant reaches a block in the qualifying-hands strip', () => {
    /* Giving the client its real `pineapple` key made the bar correct and left
       this strip with nothing to highlight: blockKeyFor returned 'pineapple'
       and no block had that key. */
    const strip = read('src/components/bbj/BBJQualifyingHands.tsx');
    const blockBody = strip.slice(
      strip.indexOf('const BLOCKS'),
      strip.indexOf('\n];', strip.indexOf('const BLOCKS'))
    );
    const blockKeys = new Set([...blockBody.matchAll(/key: '([a-z0-9_]+)'/g)].map((m) => m[1]));
    const aliasBody = strip.slice(
      strip.indexOf('function blockKeyFor'),
      strip.indexOf('\n}', strip.indexOf('function blockKeyFor'))
    );
    const aliases = new Map(
      [...aliasBody.matchAll(/raw === '([a-z0-9_]+)'\) return '([a-z0-9_]+)'/g)].map((m) => [
        m[1],
        m[2],
      ])
    );
    for (const [key, entry] of Object.entries(qualifyingHands(CLIENT))) {
      if (entry.eligible === false) continue;
      const resolved = aliases.get(key) ?? key;
      expect(
        blockKeys.has(resolved),
        `${key} resolves to '${resolved}', which is not a block - that variant highlights nothing`
      ).toBe(true);
    }
  });

  it('the rules table lists the live variants, including pineapple', () => {
    const rows = read('src/components/bbj/BBJRulesPanel.tsx');
    for (const key of ['nlh', 'plo4', 'plo8', 'plo5', 'pineapple']) {
      expect(rows, `VARIANT_ROWS must list ${key}`).toContain(`key: '${key}'`);
    }
  });
});

describe('one hand produces one near miss, not two', () => {
  it('the mini near miss is only recorded when the main said nothing', () => {
    /* The MAIN bar is inside the MINI bar, so every main near miss was also a
       mini near miss: two bbj_near_misses rows, two hub events and two toasts
       for one hand, and triple-counted reasons in any analytics. */
    const settle = read('server/src/engine/ServerTableEngineSettlement.ts');
    expect(settle).toMatch(/let mainNearMissReported = false;/);
    expect(settle).toMatch(/mainNearMissReported = true;/);
    expect(settle).toMatch(
      /const miniNearMiss = mainNearMissReported\s*\n?\s*\? \{ nearMiss: false as const \}/
    );
  });
});

describe('the rules page states the rule the engine applies', () => {
  /*
   * A FLAG A PLAYER CAN READ MUST BE A FLAG THE ENGINE OBEYS (2026-09-11).
   *
   * `BBJ_RULES.splitIfMultipleQualify` read `true` in both halves, and
   * BBJQualifyingHands printed, to every player: "If More Than One Player
   * Loses With A Qualifying Hand, The Prize Is Divided Between Them."
   * `detectBBJHit` has never divided anything. It evaluates every loser and
   * pays the STRONGEST qualifying hand - the worse beat - and the engine's own
   * comment called the split "a documented aspiration" while the surface above
   * it stated the aspiration as the rule.
   *
   * Two of the four flags in that object (`excludeDoubleBoard`,
   * `onlyFirstRunout`) already had a law proving the engine enforces them.
   * This was the third, and the only one a player could read.
   */
  const CLIENT_CFG = 'src/config/RakeConfig.ts';
  const SERVER_CFG = 'server/src/config/RakeConfig.ts';

  const flagValue = (file: string, flag: string): string => {
    const src = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const m = new RegExp(`${flag}:\\s*(true|false)`).exec(src);
    expect(m, `${file} must declare ${flag}`).toBeTruthy();
    return m![1];
  };

  it('both halves agree on splitIfMultipleQualify', () => {
    expect(flagValue(CLIENT_CFG, 'splitIfMultipleQualify')).toBe(
      flagValue(SERVER_CFG, 'splitIfMultipleQualify')
    );
  });

  it('it is false, because the engine pays one holder', () => {
    /* If a split is ever built - the atomic payout RPC taking two bad-beat
       holders - this pin moves WITH that mechanism, in the same commit. Until
       then the flag must not claim a payout shape that cannot happen. */
    expect(flagValue(SERVER_CFG, 'splitIfMultipleQualify')).toBe('false');
  });

  it('the engine picks the single strongest qualifying loser', () => {
    const src = read(SERVER_CFG);
    const loop = src.slice(
      src.indexOf('// 3. Check each loser against the qualifying minimum.'),
      src.indexOf('if (best) {')
    );
    expect(loop, 'the strongest-loser loop must exist').toBeTruthy();
    expect(loop).toMatch(/loser\.handRanking > best\.handRanking/);
    // one holder, named once - there is no second bad-beat recipient
    expect(src).toMatch(/loserUserId: best\.userId/);
  });

  it('the surface has words for the rule that is actually applied', () => {
    const panel = read('src/components/bbj/BBJQualifyingHands.tsx');
    /* The false branch is the one players see today, so it cannot be empty:
       silence about the multi-qualifier case is how the old sentence survived
       unchallenged. */
    expect(panel).toContain('The Strongest Losing Hand Takes It.');
    expect(panel).toMatch(/BBJ_RULES\.splitIfMultipleQualify\s*\n?\s*\?/);
  });
});
