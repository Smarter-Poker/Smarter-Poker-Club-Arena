/**
 * THE CASH-GAME VOCABULARY IS ONE LIST IN THREE PLACES (Operation Table
 * Stakes, Slice 1 - OPORD 1.3 section 7, ROE 16). 2026-09-04.
 *
 * The picker offers the variants the engine deals, the create function admits
 * exactly those, and the cash_games CHECK stores exactly those. If any one of
 * the three drifts, a host either cannot create a game the engine would deal,
 * or creates one it will not - and ROE 16 says the second must never be
 * silently saved as NLHE. So the three lists are pinned to each other, with
 * the engine's own KNOWN_VARIANTS (server/src/engine/VariantRules.ts) as the
 * source of truth.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASH_VARIANTS,
  CASH_VARIANT_IDS,
  CASH_TEMPLATES,
  isDealtVariant,
} from '../../src/config/cashGames';
import { KNOWN_VARIANTS } from '../../server/src/engine/VariantRules';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SQL = read('supabase/migrations/20260904160500_cash_games_slice_1.sql');

/** Every quoted variant list in the migration that starts at nlh, as sorted arrays. */
const sqlVariantLists = (): string[][] =>
  [...SQL.matchAll(/IN \(('nlh'(?:,\s*'[a-z0-9_]+')+)\)/g)].map((m) =>
    m[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort()
  );

describe('the picker offers what the engine deals', () => {
  it('CASH_VARIANTS is exactly KNOWN_VARIANTS', () => {
    expect([...CASH_VARIANT_IDS].sort()).toEqual([...KNOWN_VARIANTS].sort());
  });

  it('every id is unique and has a label a player can read', () => {
    expect(new Set(CASH_VARIANT_IDS).size).toBe(CASH_VARIANTS.length);
    for (const v of CASH_VARIANTS) expect(v.label.length).toBeGreaterThan(0);
  });

  it('isDealtVariant is the same question', () => {
    for (const id of KNOWN_VARIANTS) expect(isDealtVariant(id)).toBe(true);
    expect(isDealtVariant('nlhe')).toBe(false);
    expect(isDealtVariant('limit_holdem')).toBe(false);
    expect(isDealtVariant(null)).toBe(false);
  });
});

describe('the database admits and stores exactly the same list', () => {
  it('the cash_games CHECK and the create refusal name every dealt variant and nothing else', () => {
    const lists = sqlVariantLists();
    // The CHECK on cash_games.variant and the VARIANT_UNAVAILABLE gate.
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) expect(list).toEqual([...KNOWN_VARIANTS].sort());
  });

  it('refuses an unknown variant by name rather than defaulting it (ROE 16)', () => {
    expect(SQL).toMatch(
      /RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;/
    );
  });
});

describe('the three templates are the three sections 8 names', () => {
  it('classic, action, madness - in that order', () => {
    expect(CASH_TEMPLATES.map((t) => t.id)).toEqual(['classic', 'action', 'madness']);
    expect(SQL).toMatch(
      /template_name\s+text NOT NULL CHECK \(template_name IN \('classic', 'action', 'madness'\)\)/
    );
  });
});
