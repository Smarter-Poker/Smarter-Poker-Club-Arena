/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RAKE IS ATTRIBUTED ONCE, AT SETTLEMENT (Phase 6, 2026-09-07)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * fn_settle_tournament_rake -> fn_attribute_tournament_rake credits the VIP,
 * the agent commission and the player_stats of EVERY tournament rake row when
 * the tournament settles (117,163 settlements, 587,261.01 of 592,171.58
 * lifetime tournament rake). That is the one door.
 *
 * RakebackSettlerService also walked every rake_records row with
 * player_contributions and credited agent commission and player_stats per
 * row. Spin books carry contributions, so every spin was paid twice: on
 * 2026-09-05, 6,753 spins carrying 38,922.72 of rake earned agents 23,263.81
 * here ('tournament_fee') AND 26,742.03 at settlement - 90,396.99 of
 * 'tournament_fee' commission in the week of 2026-08-31. The database trigger
 * had the same shape for VIP (20260907214446).
 *
 * The law: the per-row commission and player_stats paths in this service are
 * for cash rows only. A tournament row is left to settlement.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isTournamentRakeRow } from './RakebackSettlerService.js';

const SRC = fs.readFileSync(
  path.join(process.cwd(), 'src/services/RakebackSettlerService.ts'),
  'utf8'
);
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('tournament rake is attributed once, at settlement', () => {
  it('recognises a tournament row by either flag', () => {
    expect(isTournamentRakeRow({ is_tournament: true })).toBe(true);
    expect(isTournamentRakeRow({ tournament_id: '4b2e6b3e-0000-4000-8000-000000000001' })).toBe(
      true
    );
    expect(isTournamentRakeRow({ is_tournament: false, tournament_id: null })).toBe(false);
    expect(isTournamentRakeRow({})).toBe(false);
  });

  it('reads tournament_id as well as is_tournament from rake_records', () => {
    expect(code).toMatch(
      /'id, is_tournament, tournament_id, hand_id, club_id, rake_amount, player_contributions, rake_method, created_at'/
    );
  });

  it('filters both tournament identities before the source batch is constructed', () => {
    expect(code).toMatch(
      /const cashRows = sourceRows\.filter\(\(row\) => !isTournamentRakeRow\(row\)\)/
    );
    expect(code.indexOf('const cashRows')).toBeLessThan(
      code.indexOf("source_type: 'cash_rake_record'")
    );
    expect(code).not.toMatch(/tournament_fee/);
  });
  it('has no independent player-stats or commission calculation loop', () => {
    expect(code).not.toMatch(/fn_apply_rakeback_player_stats_batch|statsItems|commissionItems/);
  });
});
