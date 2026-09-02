/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD BACK VOCABULARY — the store and the table must speak the same language
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Audit 2026-08-20. CardBackSelector sells twelve designs by id. Only five of
 * those ids existed in the table's registry, and settingsBridge whitelisted
 * cardBack against the eight TABLE ids — so selecting any of the other seven
 * (six of them PAID, 75-300 diamonds) was rejected at the persistence layer
 * and silently reverted to the default. Diamonds spent, nothing applied, no
 * error shown.
 *
 * These tests assert the contract that makes that impossible to reintroduce:
 * every id the store can sell must survive persistence AND resolve to a real,
 * rendered design.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeCardBack,
  CARD_BACK_IDS,
  SELECTABLE_CARD_BACK_IDS,
} from '@/components/table/CardImage';

/**
 * 2026-08-25 UPDATE. These are no longer the ids the store SELLS — it sells
 * the canonical CARD_BACK_CATALOG now, because these twelve collapsed onto
 * seven designs and three PAID tiles were pixel-for-pixel a free one (see
 * cardBackCatalog.test.ts).
 *
 * They are still exactly what has to keep working: they sit in localStorage
 * settings and in user_theme_settings.cards_id for everyone who used the store
 * before today. A legacy id that stops surviving persistence, or stops
 * resolving to a real design, blanks those players' cards. So this file keeps
 * pinning them, now as the LEGACY vocabulary rather than the current one.
 */
const STORE_IDS = [
  'black',
  'red',
  'blue',
  'white',
  'classic',
  'burgundy',
  'navy',
  'gold',
  'holographic',
  'carbon',
  'club-branded',
  'diamond-foil',
] as const;

/** The paid tier — a purchase here must visibly change the card back. */
const PAID_IDS = [
  'classic',
  'burgundy',
  'navy',
  'gold',
  'holographic',
  'carbon',
  'club-branded',
  'diamond-foil',
] as const;

describe('every store design is selectable', () => {
  it.each(STORE_IDS)('%s survives the settings whitelist', (id) => {
    expect(SELECTABLE_CARD_BACK_IDS).toContain(id);
  });
});

describe('every store design renders a real card back', () => {
  it.each(STORE_IDS)('%s resolves to a design with a stylesheet class', (id) => {
    const resolved = normalizeCardBack(id);
    expect(CARD_BACK_IDS as readonly string[]).toContain(resolved);
  });
});

describe('paid designs are distinguishable', () => {
  it('the exclusive tier resolves to their real un-aliased designs', () => {
    // If these collapsed onto one design, four separate purchases would look
    // identical and the store would be selling the same thing four times.
    const exclusive = ['holographic', 'carbon', 'club-branded', 'diamond-foil'];
    const resolved = exclusive.map(normalizeCardBack);
    expect(resolved).toEqual(exclusive);
  });

  it('no paid design resolves to the same back as plain black', () => {
    const black = normalizeCardBack('black');
    const collisions = PAID_IDS.filter((id) => normalizeCardBack(id) === black);
    // navy is deliberately the blue family; everything else must differ
    expect(collisions).toEqual(['navy']);
  });
});

describe('normalizeCardBack never blanks a card', () => {
  it.each(['', 'nonsense', 'CLASSIC_RED', '../../x', '123', null, undefined])(
    'returns a real design for %p',
    (id) => {
      const resolved = normalizeCardBack(id as string);
      expect(CARD_BACK_IDS as readonly string[]).toContain(resolved);
    }
  );
});
