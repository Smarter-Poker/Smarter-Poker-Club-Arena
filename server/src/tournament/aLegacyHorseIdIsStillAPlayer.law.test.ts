import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));

import { UUID_SHAPE, isUuidShape } from '../lib/uuidShape.js';
import { assignTournamentPlayerSeatAtomically } from './tournamentSeatAssignmentRpc.js';

/**
 * A legacy horse id is still a player (CLAUDE.md 10.5).
 *
 * 62 of the 1,000 horses were minted before the fleet used gen_random_uuid():
 * 00000000-0000-0000-0000-0000000000NN and face0000-0000-0000-0000-0000000000NN.
 * Postgres stores them in uuid columns without complaint and has seated,
 * paid and settled them since February. On 2026-09-09 the atomic
 * seat-assignment verifier required RFC-4122 version and variant nibbles,
 * so the database committed each such seat, returned ok:true, and the
 * engine read the committed receipt as invalid, called the outcome unknown
 * and aborted the launch. Nineteen MTTs sat REGISTERING for a day holding
 * 881 live seats, and every club card counted those seats as ACTIVE.
 *
 * The law: nothing in the tournament path validates an id more tightly than
 * the column that stores it.
 */
const LEGACY_HORSE_IDS = [
  '00000000-0000-0000-0000-000000000006',
  '00000000-0000-0000-0000-000000000048',
  '00000000-0000-0000-0000-000000000051',
  'face0000-0000-0000-0000-000000000001',
  'face0000-0000-0000-0000-00000000000a',
];

const STRICT_RFC4122 = /\[1-5\]\[0-9a-f\]\{3\}-\[89ab\]/;

describe('a legacy horse id is still a player', () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it('the shared shape accepts every legacy horse id and still refuses garbage', () => {
    for (const id of LEGACY_HORSE_IDS) {
      expect(isUuidShape(id), id).toBe(true);
    }
    expect(isUuidShape('5dcd833e-240f-4a62-bbf9-2dcb69dcb465')).toBe(true);
    expect(isUuidShape('00000000-0000-0000-0000-00000000000')).toBe(false);
    expect(isUuidShape('not-a-uuid')).toBe(false);
    expect(isUuidShape('')).toBe(false);
    expect(isUuidShape(null)).toBe(false);
    expect(UUID_SHAPE.source).not.toMatch(STRICT_RFC4122);
  });

  it('a committed seat for a legacy horse is an exact receipt, not an unknown outcome', async () => {
    const tournamentId = '3e0215ad-e020-48cb-b5f1-b5e82a4857ef';
    const tableId = '8cec43e0-d3ab-49ef-a991-5717235841c9';
    for (const userId of LEGACY_HORSE_IDS) {
      mocks.rpc.mockResolvedValueOnce({
        data: {
          ok: true,
          replayed: false,
          tournament_id: tournamentId,
          user_id: userId,
          table_id: tableId,
          seat_id: 'a4066678-8d15-43c1-9e05-627cc693540a',
          seat_number: 7,
          stack: 5000,
          current_players: 7,
          assigned_at: '2026-09-09T22:38:33.230Z',
        },
        error: null,
      });
      const receipt = await assignTournamentPlayerSeatAtomically({
        tournamentId,
        userId,
        tableId,
        seatNumber: 7,
      });
      expect(receipt.userId).toBe(userId);
      expect(receipt.seatNumber).toBe(7);
      expect(receipt.stack).toBe(5000);
    }
  });

  it('no file in the tournament path validates an id by RFC-4122 version or variant', () => {
    const dir = join(__dirname);
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(join(dir, name), 'utf8');
      if (STRICT_RFC4122.test(source)) offenders.push(name);
    }
    expect(
      offenders,
      'validate player ids with UUID_SHAPE from server/src/lib/uuidShape.ts, never by version nibble'
    ).toEqual([]);
  });
});
