import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const manager = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const start = sliceMethod(manager, 'private async startLifecycle(');
const prove = sliceMethod(manager, 'private async proveTournamentLaunchSetup(');
const tableBuild = sliceMethod(manager, 'createTablesAndSeatPlayers(tournament: any)');
const migration = readFileSync(
  join(
    here,
    '../../../supabase/migrations/20260909183217_a_played_spin_with_one_vacated_busted_seat_can_complete_laun.sql'
  ),
  'utf8'
);

describe('a played Spin with one vacated bust has one narrow launch path', () => {
  it('asks PostgreSQL before lowering the field and keeps Heads-Up outside the branch', () => {
    const recovery = start.indexOf(
      "supabase.rpc(\n          'fn_prove_played_spin_launch_recovery'"
    );
    const fieldRefusal = start.indexOf('if ((regCount || 0) < requiredField)');

    expect(start).toContain(
      'spinPaidGateWillRun && requiredField === SPEC_SPIN_SEATS && regCount === 2'
    );
    expect(recovery).toBeGreaterThan(-1);
    expect(recovery).toBeLessThan(fieldRefusal);
    expect(start).toContain('requiredField = playedSpinRecovery.activePlayerIds.length');
    expect(migration).toContain("AND f.variant <> 'sng'");
    expect(migration).toContain("AND f.tournament_type <> 'SNG'");
    expect(migration).toContain('AND f.max_players = 3');
  });

  it('keeps the original three identities for payment but only the two survivors for seating', () => {
    expect(start).toMatch(/const regIds =\s*playedSpinRecovery\?\.originalPlayerIds \?\?/);
    expect(start).toContain(
      "expectedLaunchPlayerIds = (regRows ?? []).map((row) => String(row.user_id ?? ''))"
    );
    expect(start).toContain('userId !== playedSpinRecovery?.activePlayerIds[index]');
    expect(tableBuild).toContain(".in('status', ['registered', 'playing'])");
    expect(tableBuild).not.toContain("'eliminated'");
  });

  it('keeps all three bought stacks in both manager conservation checks', () => {
    expect(start).toContain(
      'playedSpinRecovery?.fundingFieldSize ?? expectedLaunchPlayerIds.length'
    );
    expect(prove).toContain('const expectedFloor = fundingFieldSize * startingChips;');
    expect(
      prove.match(
        /launchStacksMeetFundingFloor\([\s\S]*?fundingFieldSize,[\s\S]*?seatFirstLaunch/g
      ) ?? []
    ).toHaveLength(2);
    expect(prove).toContain('playedSpinRecovery === null');
    expect(prove).toContain('Number(seat.stack) !== Number(player.chips)');
  });

  it('does not replay the wheel, restamp its clock, or hold a game that already dealt', () => {
    expect(start).toMatch(/if \(!playedSpinRecovery\) \{\s*this\.stampSpinRevealAnchor/);
    expect(start).toMatch(
      /if \(!playedSpinRecovery\) \{\s*if \(this\.seatFirstTableIds\.length > 0/
    );
    expect(start).toContain('if (!playedSpinRecovery && revealIsSpin && revealMultiplier > 0)');
    expect(start).toContain('? tournament.spin_reveal_lag_ms');
    expect(start).toContain('? tournament.spin_reveal_at');
  });

  it('rechecks the same database proof inside the status transaction', () => {
    const recoveryProof = migration.indexOf(
      'public.fn_prove_played_spin_launch_recovery(p_tournament_id)'
    );
    const lowerField = migration.indexOf('v_required_field := 2;', recoveryProof);
    const ordinaryRefusal = migration.indexOf(
      'IF v_active_count < v_required_field OR v_bad_roster_count <> 0 THEN',
      lowerField
    );

    expect(recoveryProof).toBeGreaterThan(-1);
    expect(lowerField).toBeGreaterThan(recoveryProof);
    expect(ordinaryRefusal).toBeGreaterThan(lowerField);
    expect(migration).toContain('AND f.hand_count >= 1');
    expect(migration).toContain('AND f.roster_chips = f.funding_floor');
    expect(migration).toContain('AND f.seat_chips = f.funding_floor');
    expect(migration).toContain('AND f.seat_chips = f.roster_chips');
    expect(migration).toContain('AND tp.chips IS NOT DISTINCT FROM s.stack');
    expect(migration).toContain('AND f.positive_active_players = 2');
    expect(migration).toContain('AND f.positive_live_seats = 2');
    expect(migration).toContain('AND f.payment_count = 3');
    expect(migration).toContain('AND f.entitlement_count = 3');
    expect(migration).toContain('AND f.source_charge_count = 3');
    expect(migration).toContain('AND f.exact_source_charges = 3');
    expect(migration).toContain('AND f.contribution_count = 1');
    expect(migration).toContain('AND f.draw_count = 1');
    expect(migration).toContain('AND f.exact_entry_journals = 1');
    expect(migration).toContain('AND f.exact_draw_journals = 1');
  });
});
