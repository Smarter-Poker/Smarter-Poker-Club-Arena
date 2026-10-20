/** Finite witness evidence only. Raw frames/cards never leave this function. */
import { cycleClock } from './lightning-pilot-cycle.mjs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function recoveryWireObservation(rooms, playerId) {
  const rows = new Map(
    rooms.map((room) => [
      room,
      {
        room,
        privateOwnFrames: 0,
        privateForeignFrames: 0,
        publicBettingSnapshots: 0,
        opponentCardViolations: 0,
        clockFrames: 0,
        clock: null,
      },
    ])
  );
  const clocks = new Map();
  let unexpectedRoomPrivateFrames = 0;
  return {
    receive(payload) {
      try {
        const frame = JSON.parse(String(payload));
        const row = rows.get(frame.tableId);
        if (frame.type === 'USER_EVENT' && frame.payload?.kind === 'hole_cards') {
          const own = frame.payload.row;
          if (!Array.isArray(own?.cards) || own.cards.length === 0) return;
          if (!row) {
            unexpectedRoomPrivateFrames++;
            return;
          }
          if (own.table_id !== frame.tableId || own.user_id !== playerId)
            row.privateForeignFrames++;
          else row.privateOwnFrames++;
          return;
        }
        if (!row) return;
        if (frame.type === 'SNAPSHOT' || frame.type === 'DELTA') {
          const clock = cycleClock(payload, frame.tableId, clocks.get(frame.tableId));
          clocks.set(frame.tableId, clock);
          if (
            uuid.test(clock.hand_id) &&
            Number.isFinite(clock.turn_deadline_ms) &&
            clock.turn_deadline_ms > 0
          ) {
            row.clockFrames++;
            row.clock = { handId: clock.hand_id, deadlineMs: clock.turn_deadline_ms };
          }
        }
        const state = frame.type === 'SNAPSHOT' ? frame.state : null;
        // Showdown and all-in runout may expose tabled hands. Inspect only an
        // actual live betting snapshot with an acting player's running clock.
        if (
          state &&
          ['preflop', 'flop', 'turn', 'river'].includes(state.stage) &&
          uuid.test(state.current_player) &&
          Number.isFinite(state.turn_deadline_ms) &&
          state.turn_deadline_ms > 0 &&
          Array.isArray(state.players) &&
          state.players.length >= 2 &&
          state.players.length <= 10 &&
          state.players.every((p) => uuid.test(p?.user_id) && Array.isArray(p.cards))
        ) {
          row.publicBettingSnapshots++;
          if (state.players.some((p) => p.user_id !== playerId && p.cards.some((c) => c != null)))
            row.opponentCardViolations++;
        }
      } catch {
        /* Unreadable frames provide no evidence. */
      }
    },
    summary() {
      return {
        scope: 'sample_only',
        unexpectedRoomPrivateFrames,
        rooms: [...rows.values()].map((r) => ({ ...r, clock: r.clock && { ...r.clock } })),
      };
    },
  };
}

/** Fixed classes only: no URL, page text, cards or session data. */
export function recoveryUiInPage() {
  const path = location.pathname;
  const route = path.startsWith('/hub/club-arena/table/')
    ? 'table'
    : path.startsWith('/hub/club-arena/lightning/')
      ? 'entry'
      : path === '/auth/login'
        ? 'login'
        : 'other';
  const visible = (selector) =>
    !![...document.querySelectorAll(selector)].find((n) => n.getClientRects().length);
  const layers = [
    ['[aria-labelledby="club-arena-welcome-title"]', 'device_welcome'],
    ['[aria-labelledby="complete-profile-title"]', 'profile'],
    ['[aria-labelledby="age-gate-title"]', 'age'],
    ['[aria-labelledby="tos-title"]', 'terms'],
    ['[aria-labelledby="dbs-title"]', 'daily_bonus'],
    ['[aria-labelledby="ca-consent-title"]', 'analytics'],
    ['[aria-label="Enable Notifications"]', 'notifications'],
  ];
  return {
    route,
    layer: layers.find(([selector]) => visible(selector))?.[1] ?? 'none',
    tabCount: Math.min(10, document.querySelectorAll('[data-tabid]').length),
    profileGate: ['pending', 'complete', 'incomplete', 'unavailable'].includes(
      document.querySelector('[data-profile-gate-status]')?.getAttribute('data-profile-gate-status')
    )
      ? document
          .querySelector('[data-profile-gate-status]')
          .getAttribute('data-profile-gate-status')
      : 'unavailable',
  };
}
