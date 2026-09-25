/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FOUR FACTS A SEATED PLAYER'S HUD NEEDS, ON THE BUS (2026-09-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TournamentHUD no longer binds `t-break-<id>` itself: a Realtime binding
 * cannot be removed while TablePage still holds the channel, so every remount
 * left one more live listener behind. It hears the channel through the bus
 * instead, which means the relay has to carry everything the bar reacts to.
 * It already carried breaks, levels and busts. These four were missing.
 *
 * They ride TOURNAMENT_UPDATED with the engine's event named in `status`, the
 * shape level_up already uses (`blind_level_<n>`). The emits are literals, one
 * per case, because tests/unit/noDeadBusSubscriptions.test.ts finds
 * publishers by scanning for `masterBus.emit('NAME'`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';

const emitted: Array<{ name: string; payload: any }> = [];
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: (name: string, payload: any) => {
      emitted.push({ name, payload });
    },
  },
}));

import { relayTournamentEvent } from '../../src/services/tournamentEventBridge';

/** The relay dedupes on event identity for 1500ms; separate ids keep cases apart. */
let seq = 0;
const tid = () => `hud-relay-${++seq}`;

beforeEach(() => {
  emitted.length = 0;
});

describe('relaying what the HUD reacts to', () => {
  it('relays late_reg_closed', () => {
    const id = tid();
    relayTournamentEvent(id, { type: 'late_reg_closed', payload: { prizePool: 1200 } });
    expect(emitted).toEqual([
      { name: 'TOURNAMENT_UPDATED', payload: { tournamentId: id, status: 'late_reg_closed' } },
    ]);
  });

  it('relays the add-on window opening, and a moved window again', () => {
    const id = tid();
    relayTournamentEvent(id, {
      type: 'ADDON_PERIOD_START',
      payload: { endsAt: '2026-09-22T12:01:00.000Z' },
    });
    // A thaw shifts the window and the engine announces the new one.
    relayTournamentEvent(id, {
      type: 'ADDON_PERIOD_START',
      payload: { endsAt: '2026-09-22T12:06:00.000Z' },
    });
    expect(emitted.map((e) => e.payload.status)).toEqual([
      'addon_period_start',
      'addon_period_start',
    ]);
  });

  it("carries bubble_burst's count, and never invents one", () => {
    const id = tid();
    relayTournamentEvent(id, { type: 'bubble_burst', payload: { playersRemaining: 17 } });
    expect(emitted[0]).toEqual({
      name: 'TOURNAMENT_UPDATED',
      payload: { tournamentId: id, status: 'bubble_burst', playersRemaining: 17 },
    });

    // `Number(null)` is 0: an unreadable count must stay unknown, not "0 left".
    const other = tid();
    relayTournamentEvent(other, { type: 'bubble_burst', payload: { playersRemaining: null } });
    expect(emitted[1].payload.status).toBe('bubble_burst');
    expect(emitted[1].payload.playersRemaining).toBeUndefined();
  });

  it('relays final_table without raising the final-table celebration', () => {
    const id = tid();
    relayTournamentEvent(id, { type: 'final_table', payload: { playerCount: 9 } });
    expect(emitted).toEqual([
      { name: 'TOURNAMENT_UPDATED', payload: { tournamentId: id, status: 'final_table' } },
    ]);
    // TablePage publishes FINAL_TABLE_REACHED itself, for MTTs only, with the
    // seated field. A copy from here would celebrate on a Spin's first hand.
    expect(emitted.some((e) => e.name === 'FINAL_TABLE_REACHED')).toBe(false);
  });

  it('relays each fact once when several mounted pages hear the same broadcast', () => {
    const id = tid();
    for (let i = 0; i < 3; i++) {
      relayTournamentEvent(id, { type: 'late_reg_closed', payload: {} });
      relayTournamentEvent(id, { type: 'bubble_burst', payload: { playersRemaining: 12 } });
      relayTournamentEvent(id, { type: 'final_table', payload: { playerCount: 9 } });
    }
    expect(emitted.map((e) => e.payload.status)).toEqual([
      'late_reg_closed',
      'bubble_burst',
      'final_table',
    ]);
  });

  it('keeps each emit a literal the dead-subscription guard can find', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/services/tournamentEventBridge.ts'),
      'utf8'
    );
    for (const type of [
      "'late_reg_closed'",
      "'ADDON_PERIOD_START'",
      "'bubble_burst'",
      "'final_table'",
    ]) {
      expect(sliceBlockAfter(src, `case ${type}:`)).toMatch(
        /masterBus\.emit\('TOURNAMENT_UPDATED'/
      );
    }
  });
});
