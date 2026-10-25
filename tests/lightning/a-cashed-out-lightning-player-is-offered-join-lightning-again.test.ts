/**
 * A PLAYER WHOSE POOL SESSION ENDED AND WHOSE ANCHOR SEAT WAS CASHED OUT IS
 * OFFERED JOIN LIGHTNING AGAIN (2026-10-24).
 *
 * The parked anchor now stands up every player whose Lightning pool session
 * ended (server: standUpPlayersWhosePoolSessionEnded), through their own
 * Leave/cash-out into their club wallet. When that player comes back, the
 * database answers with NULL seat pointers:
 *
 *   - fn_lightning_reconnect_state: the latest exited session, state 'ended',
 *     exit_reason verbatim, seat_table_id / seat_number NULL (the seat was
 *     stood up, so it points at no chair);
 *   - fn_lightning_my_session: no open session and no live seat in the
 *     Cluster, so { pool_session_id: null } and nothing else.
 *
 * Pinned here: the room's ending names how it ended and points at no seat,
 * its VIEW GAME goes to the Cluster's entry, and the entry offers JOIN
 * LIGHTNING (never VIEW GAME at a chair that is gone). An OPEN session whose
 * anchor seat pointer is NULL is read without a guess and still opens its room.
 */
import { describe, expect, it } from 'vitest';
import {
  LIGHTNING_TIMED_OUT_TITLE,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
} from '../../src/lightning/lightningReconnect';
import {
  hasLightningRoom,
  lightningEntryDecision,
  lightningReturnTableId,
  parseLightningMySession,
  type LightningClusterMeta,
} from '../../src/lightning/lightningSession';

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';

const meta = {
  clusterId: CLUSTER,
  name: 'FLH 0.25/0.50 Lightning Games',
  templateName: 'action',
  handedness: 6,
  clusterMode: 'lightning',
  enabled: true,
} as unknown as LightningClusterMeta;

describe('a cashed-out Lightning player comes back', () => {
  it('the room says the session timed out and points at no seat', () => {
    const state = parseLightningReconnectState({
      pool_session_id: POOL,
      state: 'ended',
      in_hand: false,
      hand_id: null,
      disconnected_at: '2026-10-24T15:49:46.347+00:00',
      stop_requested: false,
      seat_table_id: null,
      seat_number: null,
      stack: 38.74,
      joinable: true,
      exit_reason: 'disconnect_expired',
    });
    expect(state.seatTableId).toBeNull();
    expect(state.seatNumber).toBeNull();
    const verdict = lightningReconnectVerdict(POOL, state);
    expect(verdict).toEqual({
      kind: 'ended',
      timedOut: true,
      stopped: false,
      rgLimit: false,
      seatTableId: null,
    });
    if (verdict.kind !== 'ended') throw new Error('unreachable');
    // No "Your Seat Is Ready" line: there is no seat.
    expect(lightningSessionEndText(verdict)).toBe(`${LIGHTNING_TIMED_OUT_TITLE}.`);
  });

  it('the entry offers JOIN LIGHTNING, never a chair that is gone', () => {
    const session = parseLightningMySession({ pool_session_id: null });
    expect(hasLightningRoom(session)).toBe(false);
    expect(lightningReturnTableId(session)).toBeNull();
    expect(lightningEntryDecision(session, meta)).toEqual({
      kind: 'entry',
      joinLabel: 'Join Lightning',
      lightning: true,
    });
  });

  it('an open session with a NULL anchor seat pointer is read without a guess and opens', () => {
    const session = parseLightningMySession({
      pool_session_id: POOL,
      state: 'active',
      cluster_mode: 'lightning',
      stack: 20,
      in_hand: false,
      anchor_table_id: null,
      seat_table_id: null,
      seat_number: null,
      occupancy_id: null,
    });
    expect(session.anchorTableId).toBeNull();
    expect(session.seatNumber).toBeNull();
    expect(session.occupancyId).toBeNull();
    expect(lightningEntryDecision(session, meta)).toEqual({ kind: 'open', poolSessionId: POOL });
  });
});
