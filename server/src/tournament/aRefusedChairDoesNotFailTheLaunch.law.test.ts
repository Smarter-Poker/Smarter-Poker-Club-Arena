import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));

import {
  classifySeatRefusal,
  releaseUnseatableRegistrantAtLaunch,
} from './tournamentLaunchReleaseRpc.js';

/**
 * A refused chair does not fail the launch.
 *
 * A launch seats its roster one atomic RPC at a time. Until 2026-09-09 the
 * first refused seat threw, the receipt stayed incomplete, the event stayed
 * REGISTERING, and 380 other players sat on felt that never dealt. Each
 * refusal is now answered on its own: a stale chair is retried, a seated or
 * unregistered player is skipped, and a registrant the platform cannot seat
 * at start is released with his exact refund through one service-only door
 * that requires the event's incomplete launch receipt and never releases a
 * player who holds a live seat.
 */
describe('a refused chair does not fail the launch', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it('answers every refusal the seat RPC can give, on its own', () => {
    expect(classifySeatRefusal('seat_taken')).toBe('retry_seat');
    expect(classifySeatRefusal('table_not_assignable')).toBe('retry_table');
    expect(classifySeatRefusal('player_already_seated_elsewhere')).toBe('skip');
    expect(classifySeatRefusal('player_not_registered')).toBe('skip');
    expect(classifySeatRefusal('player_not_assignable')).toBe('skip');
    expect(classifySeatRefusal('player_stack_invalid')).toBe('release');
    expect(classifySeatRefusal('tournament player already owns multiple live seats')).toBe(
      'release'
    );
    expect(classifySeatRefusal('a guard nobody has named yet')).toBe('release');
  });

  it('releases through the launch door and reads the exact receipt back', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: {
        ok: true,
        released: true,
        replayed: false,
        refunded_chips: 10,
        request_id: '9aa99afe-d146-af92-6347-0c92f68630fb',
      },
      error: null,
    });
    const result = await releaseUnseatableRegistrantAtLaunch({
      tournamentId: '9536150e-7b7b-4914-af22-deeab3766d86',
      userId: '00000000-0000-0000-0000-000000000051',
      launchId: 'a4066678-8d15-43c1-9e05-627cc693540a',
      reason: 'player_stack_invalid',
    });
    expect(result).toEqual({ released: true, replayed: false, reason: null, refundedChips: 10 });
    expect(mocks.rpc).toHaveBeenCalledWith('fn_ca_release_unseatable_registrant_at_launch', {
      p_tournament_id: '9536150e-7b7b-4914-af22-deeab3766d86',
      p_user_id: '00000000-0000-0000-0000-000000000051',
      p_launch_id: 'a4066678-8d15-43c1-9e05-627cc693540a',
      p_reason: 'player_stack_invalid',
    });
  });

  it('a refusal by the door is a refusal, never a release', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: { ok: false, reason: 'player_is_seated' },
      error: null,
    });
    const result = await releaseUnseatableRegistrantAtLaunch({
      tournamentId: '9536150e-7b7b-4914-af22-deeab3766d86',
      userId: 'face0000-0000-0000-0000-000000000001',
      launchId: 'a4066678-8d15-43c1-9e05-627cc693540a',
      reason: 'anything',
    });
    expect(result.released).toBe(false);
    expect(result.reason).toBe('player_is_seated');
  });

  it('a transport error is not a release either', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'timeout' } });
    const result = await releaseUnseatableRegistrantAtLaunch({
      tournamentId: '9536150e-7b7b-4914-af22-deeab3766d86',
      userId: '00000000-0000-0000-0000-000000000006',
      launchId: 'a4066678-8d15-43c1-9e05-627cc693540a',
      reason: 'x',
    });
    expect(result.released).toBe(false);
    expect(result.reason).toBe('rpc_error:timeout');
  });

  it('never calls the door with an id that is not uuid-shaped', async () => {
    const result = await releaseUnseatableRegistrantAtLaunch({
      tournamentId: 'not-a-uuid',
      userId: '00000000-0000-0000-0000-000000000006',
      launchId: 'a4066678-8d15-43c1-9e05-627cc693540a',
      reason: 'x',
    });
    expect(result.released).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
