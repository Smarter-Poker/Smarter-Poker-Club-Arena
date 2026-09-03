/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN REVEAL — the multiplier must not leak before the wheel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The draw is the product. Five surfaces printed the multiplier independently,
 * and the tournament NAME carried it into a sixth, a seventh and an eighth (the
 * lobby list, the table masthead, the browser tab). Fixing them one at a time
 * is how it kept coming back, so the rule now lives in one module — and these
 * tests pin both the rule itself and the fact that no surface has quietly gone
 * back to reading `spin_multiplier` raw.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isSpinTournament,
  spinMultiplierRevealed,
  spinMultiplierLabel,
} from '../../src/utils/spinReveal';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/**
 * Comments explain why a leak was closed and therefore quote the very thing
 * being banned. Scanning them would make every fix look like the bug.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('isSpinTournament', () => {
  it('accepts either column, in either case', () => {
    expect(isSpinTournament({ variant: 'spin' })).toBe(true);
    expect(isSpinTournament({ variant: 'SPIN' })).toBe(true);
    expect(isSpinTournament({ tournament_type: 'SPIN' })).toBe(true);
    expect(isSpinTournament({ tournament_type: 'spin' })).toBe(true);
  });

  it('is false for everything else, including nothing at all', () => {
    expect(isSpinTournament({ variant: 'mtt', tournament_type: 'MTT' })).toBe(false);
    expect(isSpinTournament(null)).toBe(false);
    expect(isSpinTournament(undefined)).toBe(false);
    expect(isSpinTournament({})).toBe(false);
  });
});

describe('spinMultiplierRevealed', () => {
  it('hides the answer while the Spin is still in the lobby', () => {
    for (const status of [
      'REGISTERING',
      'SCHEDULED',
      'PENDING',
      'ANNOUNCED',
      'UPCOMING',
      'REGISTRATION_OPEN',
      'registering',
    ]) {
      expect(spinMultiplierRevealed({ variant: 'spin', status }), status).toBe(false);
    }
  });

  it('reveals it once the tournament is actually under way', () => {
    for (const status of ['RUNNING', 'COMPLETED', 'CANCELLED', 'LATE_REG', 'FINISHED']) {
      expect(spinMultiplierRevealed({ variant: 'spin', status }), status).toBe(true);
    }
  });

  it('trusts started_at over any status string', () => {
    expect(
      spinMultiplierRevealed({
        variant: 'spin',
        status: 'REGISTERING',
        started_at: '2026-08-20T21:00:00Z',
      })
    ).toBe(true);
  });

  it('errs toward hiding when the state is unknown', () => {
    expect(spinMultiplierRevealed({ variant: 'spin' })).toBe(false);
    expect(spinMultiplierRevealed({ variant: 'spin', status: '' })).toBe(false);
  });

  it('never blanks a non-Spin — those have nothing to protect', () => {
    expect(spinMultiplierRevealed({ variant: 'mtt', status: 'REGISTERING' })).toBe(true);
    expect(spinMultiplierRevealed(null)).toBe(true);
  });
});

describe('spinMultiplierLabel', () => {
  it('formats only when the answer is public', () => {
    expect(spinMultiplierLabel({ variant: 'spin', status: 'RUNNING', spin_multiplier: 25 })).toBe(
      '25x'
    );
    expect(
      spinMultiplierLabel({ variant: 'spin', status: 'REGISTERING', spin_multiplier: 25 })
    ).toBeNull();
  });

  it('is null when there is no multiplier at all', () => {
    expect(spinMultiplierLabel({ variant: 'spin', status: 'RUNNING' })).toBeNull();
    expect(
      spinMultiplierLabel({ variant: 'spin', status: 'RUNNING', spin_multiplier: 0 })
    ).toBeNull();
  });
});

describe('no surface prints the multiplier on its own again', () => {
  /**
   * Source-level, deliberately. The rule is only worth anything if a new
   * surface cannot bypass it, and a rendered-component test would only cover
   * the surfaces someone remembered to write a test for.
   */
  /* DynamicGameCard was retired with the old card lobby (Lobby V2 teardown,
     2026-08-22). The V2 surfaces are listed in its place: none of them reads
     spin_multiplier at all today, and this test is what keeps it that way -
     if one ever starts, it must go through the spinReveal gate. */
  const lobbySurfaces = [
    'src/pages/TournamentPage.tsx',
    'src/pages/tournament/TournamentDetails.tsx',
    'src/components/lobby/lobbyEntries.ts',
    'src/components/lobby/LobbyTable.tsx',
    'src/components/lobby/GameLobbyPanel.tsx',
    'src/components/lobby/CasinoPlaque.tsx',
  ];

  it('a lobby surface either goes through the gate or never touches the column', () => {
    for (const path of lobbySurfaces) {
      const src = stripComments(read(path));
      if (!/spin_multiplier/.test(src)) continue; // nothing to leak
      expect(src, `${path} reads spin_multiplier without importing the gate`).toMatch(/spinReveal/);
      // The shape that leaked: `${t.spin_multiplier}x` straight into JSX.
      const raw = src.match(/\$\{[^}]*spin_multiplier[^}]*\}x/g) ?? [];
      expect(raw.length, `${path} formats spin_multiplier directly`).toBe(0);
    }
  });

  it('the tournament NAME no longer carries it', () => {
    const recurring = read('server/src/services/TournamentRecurringService.ts');
    // "3 Chip Spin NLH (4x)" reached the lobby tile, the list, the table
    // masthead and the browser tab.
    expect(recurring).not.toMatch(/name:\s*`\$\{config\.name\}\s*\(\$\{multiplier\}x\)`/);
    const i = recurring.indexOf("tournament_type: 'SPIN',");
    expect(i).toBeGreaterThan(-1);
    expect(recurring.slice(Math.max(0, i - 1400), i)).toMatch(/name:\s*config\.name,/);
  });

  it('the table badge waits for the wheel to land', () => {
    const table = read('src/pages/TablePage.tsx');
    const i = table.indexOf('spinMultiplierBadge');
    expect(i).toBeGreaterThan(-1);
    // The guard sits just above the badge markup.
    expect(table.slice(Math.max(0, i - 900), i)).toMatch(/!spinDraw\s*&&/);
  });

  /* The 'lobby tile advertises the FORMAT ceiling' case retired with
     DynamicGameCard: the V2 lobby shows no multiplier on any tile, so there
     is no drawn value to leak - and the surfaces test above fails the moment
     one of the V2 files starts reading spin_multiplier without the gate. */
});
