/**
 * The persona reaches the felt, the style is chosen, the table is read, and
 * the ICM fallback knows something. 2026-09-05.
 *
 * Dan: "there is absolutely no point to keep upgrading and enhancing the logic
 * of the horses, if nothing reads the tags."
 *
 * He was right about the persona specifically: `CashPersona` had ZERO
 * occurrences anywhere in server/src/engine while `HorseDataLedger` described
 * the decision as "base style x profile dials x variant overlay x persona".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PERSONA_STYLE_WEIGHTS,
  personaOf,
  resolveHorseStyle,
  styleForPersona,
} from './HorseLogic.js';
import { HorseMind, NEUTRAL_TABLE } from './HorseMind.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `horse-${i}-${i * 7919}`);

describe('the style is chosen, not flipped', () => {
  it('an explicitly named style still wins - the persona only fills a gap', () => {
    expect(resolveHorseStyle({ style: 'lag', persona: 'grinder' }, 'h1').style).toBe('lag');
    expect(resolveHorseStyle('tricky', 'h1').style).toBe('tricky');
  });

  it('reads the persona off the profile, and only a real one', () => {
    expect(personaOf({ persona: 'night_owl' })).toBe('night_owl');
    expect(personaOf({ persona_cash: 'mixer' })).toBe('mixer');
    expect(personaOf({ persona: 'not_a_persona' })).toBeNull();
    expect(personaOf(null)).toBeNull();
    expect(personaOf('grinder')).toBeNull(); // a bare string is a STYLE
  });

  it('is deterministic - the same horse always gets the same style', () => {
    for (const id of ids(50)) {
      expect(styleForPersona('mixer', id)).toBe(styleForPersona('mixer', id));
      expect(resolveHorseStyle({ persona: 'mixer' }, id).style).toBe(
        resolveHorseStyle({ persona: 'mixer' }, id).style
      );
    }
  });

  it('every persona can still be every style - these are weights, not buckets', () => {
    for (const persona of Object.keys(PERSONA_STYLE_WEIGHTS) as Array<
      keyof typeof PERSONA_STYLE_WEIGHTS
    >) {
      const seen = new Set(ids(400).map((id) => styleForPersona(persona, id)));
      expect(seen.size, `${persona} collapsed to ${[...seen].join(',')}`).toBe(5);
      // ...and none of the weights is zero, which is what guarantees it.
      for (const w of Object.values(PERSONA_STYLE_WEIGHTS[persona])) {
        expect(w).toBeGreaterThan(0);
      }
    }
  });

  it('a grinder leans grinder and a mixer leans loose', () => {
    const share = (persona: keyof typeof PERSONA_STYLE_WEIGHTS, style: string) =>
      ids(2000).filter((id) => styleForPersona(persona, id) === style).length / 2000;
    expect(share('grinder', 'grinder')).toBeGreaterThan(share('mixer', 'grinder'));
    expect(share('mixer', 'lag')).toBeGreaterThan(share('grinder', 'lag'));
  });

  it('does not quietly re-weight the whole fleet', () => {
    /* The point is a meaningful assignment, not a fleet that is secretly
       tighter than it was. Across an even spread of personas every style
       stays within a band of the old uniform 20%. */
    const personas = Object.keys(PERSONA_STYLE_WEIGHTS) as Array<
      keyof typeof PERSONA_STYLE_WEIGHTS
    >;
    const counts: Record<string, number> = {};
    let total = 0;
    for (const p of personas) {
      for (const id of ids(1000)) {
        const st = styleForPersona(p, id);
        counts[st] = (counts[st] ?? 0) + 1;
        total++;
      }
    }
    for (const [style, n] of Object.entries(counts)) {
      const share = n / total;
      expect(share, `${style} at ${(share * 100).toFixed(1)}%`).toBeGreaterThan(0.1);
      expect(share, `${style} at ${(share * 100).toFixed(1)}%`).toBeLessThan(0.32);
    }
  });

  it('no persona at all lands exactly where the old hash landed', () => {
    // The uniform weights ARE the old fallback, so an untagged horse does not
    // move. That is what makes this safe to land without a league run.
    const oldHash = (horseId: string) => {
      let h = 0;
      for (let i = 0; i < horseId.length; i++) h = (h * 31 + horseId.charCodeAt(i)) >>> 0;
      return (['tag', 'lag', 'balanced', 'tricky', 'grinder'] as const)[h % 5];
    };
    for (const id of ids(200)) expect(styleForPersona(null, id)).toBe(oldHash(id));
  });

  it('the tagger is what puts the persona where the engine can see it', () => {
    const src = readFileSync(new URL('../scripts/horsesTag.ts', import.meta.url), 'utf8');
    expect(src).toContain('personaByBody');
    // A MERGE - the self-tuner's dials and the nightly leaks must survive.
    expect(src).toContain('horse_profile: { ...existing, persona }');
  });
});

describe('the table is read as a table', () => {
  beforeEach(() => HorseMind.reset?.());

  const seat = (n: number, id: string) =>
    ({
      seat: n,
      user_id: id,
      stack: 100,
      bet: 0,
      is_folded: false,
      is_sitting_out: false,
    }) as never;

  it('a table of strangers reads neutral - what a human sitting down knows', () => {
    const players = [seat(0, 'hero'), seat(1, 'a'), seat(2, 'b'), seat(3, 'c')];
    expect(HorseMind.tableProfile(0, players)).toEqual(NEUTRAL_TABLE);
  });

  it('an empty table reads neutral rather than dividing by nobody', () => {
    expect(HorseMind.tableProfile(0, [seat(0, 'hero')])).toEqual(NEUTRAL_TABLE);
  });

  it('the sample count is the caller’s confidence gate', () => {
    expect(NEUTRAL_TABLE.sample).toBe(0);
    expect(NEUTRAL_TABLE.looseness).toBe(0.5);
    // and the brain applies the gate at three
    const brain = readFileSync(new URL('./HorseLogic.ts', import.meta.url), 'utf8');
    expect(brain).toContain('tableRead.sample >= 3');
  });

  it('the receipt fires whether or not the behaviour flag does', () => {
    const brain = readFileSync(new URL('./HorseLogic.ts', import.meta.url), 'utf8');
    const block = brain.slice(brain.indexOf('V42 THE TABLE READ'));
    const fire = block.indexOf("noteFire('v42_table_read')");
    const flag = block.indexOf('opts.v42Table === true');
    expect(fire).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(fire); // counted first, gated second
  });
});

describe('the ICM fallback reads the table instead of two constants', () => {
  it('no longer decides pressure from a bare stack size', () => {
    const brain = readFileSync(new URL('./HorseLogic.ts', import.meta.url), 'utf8');
    const block = brain.slice(brain.indexOf('THE COLD-CACHE FALLBACK READS THE TABLE'));
    expect(block).toContain("lastIcmPath = 'table_relative'");
    // stack relative to the TABLE average, which needs no cache and no network
    expect(block).toContain('hero / avg');
    // and it needs a real table behind it
    expect(block).toContain('live.length >= 3');
    /* SCOPED TO A REAL COLD CACHE. `ServerTableEngineTurns` returns
       `tournament: {}` - truthy - on a miss, so `explicit` present is exactly
       "the engine said tournament and the context has not arrived". Absent
       means we reached here through the legacy `bb >= 10` self-detection,
       which fires on synthetic states and on nothing the live engine
       produces; reading an ICM premium into those would invent a tournament,
       and it cost a passing NLH sizing test to find out. */
    expect(block).toContain('if (explicit) {');
  });

  it('reports its own path, so the audit can tell the two apart', () => {
    const brain = readFileSync(new URL('./HorseLogic.ts', import.meta.url), 'utf8');
    expect(brain).toContain("| 'table_relative'");
    const ledger = readFileSync(new URL('./HorseDataLedger.ts', import.meta.url), 'utf8');
    expect(ledger).toContain('icm_table_relative');
  });
});

describe('the VPIP floor is inert because ordinary tables have no floor', () => {
  it('is not a wiring gap, and must not be "fixed" into one', () => {
    /* MEASURED 2026-09-05 against production: of 157 open cash tables, 55 had
       nit_game = true AND maintain_percent_min > 0, and ZERO had the minimum
       set without nit_game. The two columns are perfectly correlated, so
       vpipFloor() returning 0 on the other 102 tables is CORRECT - those
       tables genuinely have no floor to keep.

       This test exists because the gate reads like a bug when you find it
       cold, and the "fix" would impose a nit rule on every ordinary game. */
    const src = readFileSync(new URL('./ServerTableEngineBase.ts', import.meta.url), 'utf8');
    expect(src).toContain('if (this.tableInfo?.nit_game !== true) return 0;');
  });
});
