/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ACCELERATED MTT — level halving after late reg closes (2026-08-22 parity)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * accelerated_mtt=true halves blind level durations once late registration has
 * closed: ceil(minutes / 2), never below one minute. The rule itself is the
 * pure helper; the conditional application inside
 * TournamentManagerBase.levelDurationMs (accelerated_mtt AND late reg closed)
 * is pinned as source text so a rewrite cannot silently drop it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceleratedLevelMs } from '../../server/src/tournament/acceleratedLevels';
import { sliceMethod } from '../helpers/sourceWindow';

const MIN = 60_000;

describe('acceleratedLevelMs — ceil(minutes / 2), floored at one minute', () => {
  it('halves even-minute levels exactly', () => {
    expect(acceleratedLevelMs(10 * MIN)).toBe(5 * MIN);
    expect(acceleratedLevelMs(8 * MIN)).toBe(4 * MIN);
    expect(acceleratedLevelMs(2 * MIN)).toBe(1 * MIN);
  });

  it('rounds odd-minute levels UP', () => {
    expect(acceleratedLevelMs(5 * MIN)).toBe(3 * MIN);
    expect(acceleratedLevelMs(3 * MIN)).toBe(2 * MIN);
  });

  it('never collapses a level below one minute', () => {
    expect(acceleratedLevelMs(1 * MIN)).toBe(1 * MIN);
    expect(acceleratedLevelMs(90_000)).toBe(1 * MIN); // 1.5 min -> 1 min
    expect(acceleratedLevelMs(30_000)).toBe(1 * MIN);
  });

  it('garbage in, zero out', () => {
    expect(acceleratedLevelMs(0)).toBe(0);
    expect(acceleratedLevelMs(-5)).toBe(0);
    expect(acceleratedLevelMs(NaN)).toBe(0);
  });
});

describe('levelDurationMs applies the halving conditionally (source pin)', () => {
  const BASE = readFileSync(
    resolve(__dirname, '../../server/src/tournament/TournamentManagerBase.ts'),
    'utf8'
  );

  it('halves only for accelerated_mtt tournaments after late reg closes', () => {
    const at = BASE.indexOf('protected levelDurationMs');
    expect(at).toBeGreaterThan(-1);
    const body = sliceMethod(BASE, 'protected levelDurationMs');
    expect(body).toMatch(/accelerated_mtt === true/);
    expect(body).toMatch(/isLateRegClosed\(\)/);
    expect(body).toMatch(/acceleratedLevelMs\(/);
  });

  it('isLateRegClosed follows the durable database-owned entry-window state', () => {
    const at = BASE.indexOf('protected isLateRegClosed');
    expect(at).toBeGreaterThan(-1);
    const body = sliceMethod(BASE, 'protected isLateRegClosed');
    expect(body).toMatch(/prizePoolFinalized/);
    expect(body).toMatch(/tournamentEntryWindowClosed/);
    expect(body).not.toMatch(/late_reg_levels|late_reg_mins|Date\.now/);
  });
});
