/**
 * THE CLASSIC CARD SAYS WHAT THE CHOSEN VARIANT GETS (2026-10-24).
 *
 * PLO5 and PLO6 Classic play a big blind ante and a 50% floor
 * (20261024213131); every other Classic variant has neither. The create
 * flow's Classic card used to print one fixed blurb, "No Antes, No Bombs, No
 * Minimum VPIP", over a game that stands players up at 50%.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CASH_TEMPLATES, classicBlurbFor } from '../../src/config/cashGames';

const noBombs = { enabled: false, trigger: null, ante_bb: null, boards: null };

describe('classicBlurbFor', () => {
  it('prints the BB ante and the 50% floor for a PLO5/PLO6 Classic snapshot', () => {
    expect(classicBlurbFor({ regular_ante: 'bb', vpip_floor: 50, bombs: noBombs })).toBe(
      'Standard Ring Game. Big Blind Ante, No Bombs, 50% Minimum VPIP.'
    );
  });

  it('keeps the plain Classic promise for every other variant', () => {
    expect(classicBlurbFor({ regular_ante: 'none', vpip_floor: 0, bombs: noBombs })).toBe(
      'Standard Ring Game. No Antes, No Bombs, No Minimum VPIP.'
    );
  });

  it('falls back to the template blurb before the defaults load', () => {
    expect(classicBlurbFor(null)).toBe(CASH_TEMPLATES[0].blurb);
  });

  it('never prints an em dash (popup and copy rule)', () => {
    expect(classicBlurbFor({ regular_ante: 'bb', vpip_floor: 50, bombs: noBombs })).not.toMatch(
      /—/
    );
  });
});

describe('the create flow uses it', () => {
  it('renders the Classic card from the loaded Classic snapshot', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../src/components/cash/CashGameCreateFlow.tsx'),
      'utf8'
    );
    expect(src).toMatch(
      /t\.id === 'classic' && template === 'classic' && snapshot\?\.template === 'classic'\s*\?\s*classicBlurbFor\(snapshot\)\s*:\s*t\.blurb/
    );
  });
});
