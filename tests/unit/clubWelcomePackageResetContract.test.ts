import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: backend.rpc } }));

import {
  clubWelcomePackageService,
  welcomePackageImpactHasNoBlockers,
} from '../../src/services/ClubWelcomePackageService';

const CLUB_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const GAME_ID = '33333333-3333-4333-8333-333333333333';
const TOURNAMENT_ID = '44444444-4444-4444-8444-444444444444';
const TABLE_ID = '55555555-5555-4555-8555-555555555555';
const SCHEDULE_ID = '66666666-6666-4666-8666-666666666666';

describe('pristine welcome-package reset contract', () => {
  beforeEach(() => backend.rpc.mockReset());

  it('accepts the conserved reset preview and exposes exact returned principals', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        club_id: CLUB_ID,
        package_version: 'welcome-v1',
        authorized: true,
        can_reset: true,
        cash_game_ids: [GAME_ID],
        tournament_ids: [TOURNAMENT_ID],
        blocking: { resource_activity: 0, economics_pristine: true },
        removable: {
          cash_games: 1,
          tournaments: 1,
          tables: 2,
          schedules: 1,
          bbj_seed: 100,
          spin_seed: 200,
        },
      },
      error: null,
    });

    const impact = await clubWelcomePackageService.getResetImpact(CLUB_ID);
    expect(impact.blocking).toMatchObject({ resourceActivity: 0, economicsPristine: true });
    expect(impact.removable).toMatchObject({ bbjSeed: 100, spinSeed: 200 });
    expect(welcomePackageImpactHasNoBlockers(impact)).toBe(true);
  });

  it('accepts the reset receipt without requiring retired legacy fields', async () => {
    backend.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        replayed: false,
        club_id: CLUB_ID,
        operation_id: OPERATION_ID,
        returned_to_treasury: { bbj: 100, spin: 200 },
        owner_acceptance_receipts_preserved: true,
        removed: {
          cash_game_ids: [GAME_ID],
          tournament_ids: [TOURNAMENT_ID],
          table_ids: [TABLE_ID],
          schedule_ids: [SCHEDULE_ID],
        },
        completed_at: '2026-10-02T15:30:00Z',
      },
      error: null,
    });

    await expect(clubWelcomePackageService.remove(CLUB_ID, OPERATION_ID)).resolves.toMatchObject({
      returnedToTreasury: { bbj: 100, spin: 200 },
      ownerAcceptanceReceiptsPreserved: true,
    });
  });
});

describe('welcome package persisted identifiers', () => {
  beforeEach(() => backend.rpc.mockReset());

  it.each(['a0000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111'])(
    'accepts the server not-eligible state for %s',
    async (clubId) => {
      backend.rpc.mockResolvedValue({
        data: {
          ok: true,
          club_id: clubId,
          package_version: 'welcome-v1',
          eligible: false,
          status: 'not_eligible',
          owner_acceptance_required: true,
          items: [],
        },
        error: null,
      });
      await expect(clubWelcomePackageService.get(clubId)).resolves.toMatchObject({
        clubId,
        eligible: false,
        status: 'not_eligible',
        items: [],
      });
    }
  );

  it.each([
    'not-a-uuid',
    'a0000000-0000-0000-0000-00000000000z',
    '',
    'a0000000-0000-0000-0000-000000000001.extra',
  ])('refuses a malformed persisted identifier %s', async (clubId) => {
    backend.rpc.mockResolvedValue({
      data: {
        ok: true,
        club_id: clubId,
        package_version: 'welcome-v1',
        eligible: false,
        status: 'not_eligible',
        owner_acceptance_required: true,
        items: [],
      },
      error: null,
    });
    await expect(clubWelcomePackageService.get(clubId)).rejects.toThrow();
  });
});
