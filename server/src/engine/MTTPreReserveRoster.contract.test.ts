import { test, expect } from 'vitest';
import {
  snapshotMTTPreReserveRoster,
  originalMTTRosterPayload,
  type MTTRosterObservation,
} from './MTTPreReserveRoster.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const intent = {
  admission_id: id(1),
  tournament_id: id(2),
  table_id: id(3),
  lease_generation: id(4),
  custody_id: id(5),
  permit_id: id(6),
  lifecycle: '1',
  admission_revision: '1',
  hand_number: '10',
};
function observation(): MTTRosterObservation {
  const seats = [1, 2, 3].map((n) => ({
    user_id: id(10 + n),
    username: 'player',
    is_horse: false,
    stack: 100,
    seat_number: n,
    seat_id: id(20 + n),
    occupancy_id: id(30 + n),
    seat_joined_at: '2026-09-14T00:00:00.000Z',
    left_at: null,
    entry_hold: null,
    is_sitting_out: n === 1,
  }));
  return {
    seats,
    selected: seats,
    participants: seats.map((s) => ({
      id: id(40 + s.seat_number),
      user_id: s.user_id,
      tournament_id: id(2),
      table_id: id(3),
      seat_number: s.seat_number,
      registered_at: '2026-09-13T00:00:00.000Z',
      rebuys: 0,
      status: 'playing',
    })),
    waitingForBB: new Set(),
    swapHeld: new Set(),
    table: {
      id: id(3),
      tournament_id: id(2),
      f06_lifecycle: '1',
      max_players: 9,
      game_variant: 'nlh',
      pineapple_holdem: false,
      bomb_pot_enabled: false,
    },
    tournament: { id: id(2), tournament_type: 'MTT' },
    effectiveVariant: 'nlh',
    ordinaryHand: true,
  };
}
test('complete sorted roster includes tournament sit-outs and freezes detached anchors', () => {
  const o = observation(),
    s = snapshotMTTPreReserveRoster(intent, o);
  expect(s.complete_roster).toHaveLength(3);
  expect(s.complete_roster[0].user_id).toBe(id(11));
  o.seats[0].stack = 42;
  expect(s.complete_roster[0].stack).toBe(100);
  expect(Object.isFrozen(s.complete_roster[0])).toBe(true);
  expect(Object.isFrozen(s.intent)).toBe(true);
  expect(originalMTTRosterPayload(s, { ...intent })).toBe(s.complete_roster);
});
test('lost response retry keeps original snapshot, rejects replacement intent', () => {
  const o = observation(),
    s = snapshotMTTPreReserveRoster(intent, o);
  o.seats[0].occupancy_id = id(99);
  expect(originalMTTRosterPayload(s, intent)[0].occupancy_id).toBe(id(31));
  for (const k of Object.keys(intent) as (keyof typeof intent)[])
    expect(() => originalMTTRosterPayload(s, { ...intent, [k]: intent[k] + 'x' })).toThrow(
      'original_intent_changed'
    );
});
test('local waiting and swap holds refuse rather than omit positive seats', () => {
  for (const key of ['waitingForBB', 'swapHeld'] as const) {
    const o = observation();
    o[key] = new Set([id(13)]);
    o.selected = o.seats.slice(0, 2);
    expect(() => snapshotMTTPreReserveRoster(intent, o)).toThrow('local_hold_unqualified');
  }
});
test('stale pre-rest subset and concurrent arrivals cannot qualify a partial roster', () => {
  const o = observation();
  o.selected = o.seats.slice(0, 2);
  expect(() => snapshotMTTPreReserveRoster(intent, o)).toThrow('selected_changed');
});
for (const [name, change] of Object.entries({
  missingVariant: (o: MTTRosterObservation) => {
    o.table.game_variant = null;
  },
  fallbackFormat: (o: MTTRosterObservation) => {
    o.tournament.tournament_type = null;
  },
  differentVariant: (o: MTTRosterObservation) => {
    o.effectiveVariant = 'plo4';
  },
  bomb: (o: MTTRosterObservation) => {
    o.ordinaryHand = false;
  },
  lifecycle: (o: MTTRosterObservation) => {
    o.table.f06_lifecycle = '2';
  },
  occupancy: (o: MTTRosterObservation) => {
    o.seats[0].occupancy_id = undefined;
  },
  participant: (o: MTTRosterObservation) => {
    o.participants = [];
  },
  eliminated: (o: MTTRosterObservation) => {
    o.participants[0].status = 'eliminated';
  },
  negative: (o: MTTRosterObservation) => {
    o.seats[0].stack = -1;
  },
  nonfinite: (o: MTTRosterObservation) => {
    o.seats[0].stack = Infinity;
  },
  waitingMarker: (o: MTTRosterObservation) => {
    o.seats[0].entry_hold = 'waiting';
  },
  postingMarker: (o: MTTRosterObservation) => {
    o.seats[0].entry_hold = 'posting';
  },
  duplicateSeat: (o: MTTRosterObservation) => {
    o.seats[1].seat_number = 1;
  },
  staleSeat: (o: MTTRosterObservation) => {
    o.seats[0].left_at = '2026-09-14T01:00:00Z';
  },
  capacity: (o: MTTRosterObservation) => {
    o.table.max_players = 2;
  },
}))
  test(`refuses ${name}`, () => {
    const o = observation();
    change(o);
    expect(() => snapshotMTTPreReserveRoster(intent, o)).toThrow();
  });
test('zero-stack exclusion and heads-up projection', () => {
  const o = observation();
  o.seats[2].stack = 0;
  o.selected = o.seats.slice(0, 2);
  expect(snapshotMTTPreReserveRoster(intent, o).complete_roster).toHaveLength(2);
});

import { validateMTTOriginalRosterAssociation } from './MTTPreReserveRoster.js';
test('saved exact original association validates without changing permit state', () => {
  const s = snapshotMTTPreReserveRoster(intent, observation());
  expect(validateMTTOriginalRosterAssociation(s, s, intent)).toBe(s.complete_roster);
  expect(() => validateMTTOriginalRosterAssociation(s, null, intent)).toThrow(
    'association_unresolved'
  );
  expect(() =>
    validateMTTOriginalRosterAssociation(s, { ...s, complete_roster: [] }, intent)
  ).toThrow('association_roster');
});
test('every returned row anchor is bound; no expanded roster on lost reply', () => {
  const s = snapshotMTTPreReserveRoster(intent, observation());
  for (const key of Object.keys(s.complete_roster[0])) {
    const rows = s.complete_roster.map((r) => ({ ...r }));
    (rows[0] as unknown as Record<string, unknown>)[key] = 'changed';
    expect(() =>
      validateMTTOriginalRosterAssociation(s, { ...s, complete_roster: rows }, intent)
    ).toThrow('association_roster');
  }
  expect(() =>
    validateMTTOriginalRosterAssociation(
      s,
      { ...s, complete_roster: [...s.complete_roster, s.complete_roster[0]] },
      intent
    )
  ).toThrow('association_roster');
});
test('replacement or missing association identity refuses at final revalidation', () => {
  const s = snapshotMTTPreReserveRoster(intent, observation());
  for (const key of Object.keys(intent)) {
    expect(() =>
      validateMTTOriginalRosterAssociation(
        s,
        { ...s, intent: { ...intent, [key]: 'changed' } },
        intent
      )
    ).toThrow('association_identity');
    expect(() =>
      validateMTTOriginalRosterAssociation(s, s, { ...intent, [key]: 'changed' })
    ).toThrow('original_intent_changed');
  }
});

import { bindMTTOriginalRosterInvocation } from './MTTPreReserveRoster.js';
test('original transport retry receives same request after lost reply and changed live roster', async () => {
  const o = observation(),
    s = snapshotMTTPreReserveRoster(intent, o);
  const seen: unknown[] = [];
  const invocation = bindMTTOriginalRosterInvocation(
    s,
    async (request) => {
      seen.push(request);
      if (seen.length === 1) throw Error('lost_reply');
      return s;
    },
    () => intent
  );
  await expect(invocation.begin()).rejects.toThrow('lost_reply');
  o.seats[0].stack = 999;
  o.seats[0].occupancy_id = id(99);
  expect(await invocation.begin()).toBe(s.complete_roster);
  expect(seen).toEqual([s, s]);
  expect(seen[0]).toBe(seen[1]);
});
test('replacement while original transport awaits cannot consume old association', async () => {
  const s = snapshotMTTPreReserveRoster(intent, observation());
  let current = intent;
  const invocation = bindMTTOriginalRosterInvocation(
    s,
    async () => {
      current = { ...intent, lifecycle: '2' };
      return s;
    },
    () => current
  );
  await expect(invocation.begin()).rejects.toThrow('original_intent_changed');
});

test('configured special-hand overrides cannot be certified by supplied ordinary/NLH labels', () => {
  for (const flag of ['pineapple_holdem', 'bomb_pot_enabled'] as const)
    for (const value of [true, null]) {
      const o = observation();
      o.table[flag] = value;
      expect(() => snapshotMTTPreReserveRoster(intent, o)).toThrow('unsupported_profile');
    }
});

import { captureMTTRosterBeforeReserve } from './MTTPreReserveRoster.js';
test('pre-factory capture preserves roster while original intent is allocated', () => {
  const o = observation();
  const captured = captureMTTRosterBeforeReserve(o);
  o.seats[0].stack = 999;
  o.seats[0].occupancy_id = id(99);
  o.table.game_variant = 'plo4';
  const s = captured.forOriginalIntent(intent);
  expect(s.complete_roster[0].stack).toBe(100);
  expect(s.complete_roster[0].occupancy_id).toBe(id(31));
  expect(captured.forOriginalIntent({ ...intent })).toBe(s);
  expect(() => captured.forOriginalIntent({ ...intent, permit_id: id(99) })).toThrow(
    'original_intent_changed'
  );
});

import { freezeMTTEffectiveSettings } from './MTTPreReserveRoster.js';
test('effective settings stay original across awaited live configuration changes', async () => {
  const live = {
    game_variant: 'nlh',
    pineapple_holdem: false,
    bomb_pot_enabled: false,
    bomb_pot_sched_state: { pending: false },
  };
  const original = freezeMTTEffectiveSettings(live);
  await Promise.resolve();
  live.game_variant = 'plo6';
  live.pineapple_holdem = true;
  live.bomb_pot_enabled = true;
  live.bomb_pot_sched_state.pending = true;
  expect(original).toEqual({
    game_variant: 'nlh',
    pineapple_holdem: false,
    bomb_pot_enabled: false,
    bomb_pot_sched_state: { pending: false },
  });
  expect(Object.isFrozen(original.bomb_pot_sched_state)).toBe(true);
});

import { originalRosterAdmission } from '../services/F06OriginalRosterAdmission.js';
test('actual Connected factory is synchronous and saves only its original decoded association', async () => {
  const o = observation(),
    captured = captureMTTRosterBeforeReserve(o);
  let snapshot: any;
  let begins = 0;
  const admitted: any = {
    forHand: () => intent,
    canStart: () => true,
    bindOriginalRoster: (s: any) => {
      snapshot = s;
    },
    begin: async () => {
      begins++;
      return {
        data: {
          ok: true,
          tournament_id: intent.tournament_id,
          generation: intent.lease_generation,
          custody_id: intent.custody_id,
          permit_id: intent.permit_id,
          table_id: intent.table_id,
          lifecycle: intent.lifecycle,
          hand_number: intent.hand_number,
          state: 'reserved',
        },
        error: null,
        originalRoster: { association: snapshot, entryEnrollments: [] },
      };
    },
  };
  const adapter = originalRosterAdmission(
    admitted,
    () => true,
    async () => ({ data: null, error: null }),
    async () => o
  );
  const created = adapter.factory('10', captured);
  expect(created).not.toBeInstanceOf(Promise);
  expect(begins).toBe(0);
  const permit = await created;
  await permit.reserve();
  expect(begins).toBe(1);
  expect(adapter.boundary!.saved(permit).association).toBe(snapshot);
});

import {
  assertMTTCapturedSettings,
  type MTTOriginalRosterAssociation,
  type MTTPreReserveSnapshot,
} from './MTTPreReserveRoster.js';
test('v2 captures exact SQL eligibility settings and rejects retained v1', () => {
  const o = observation(),
    s = snapshotMTTPreReserveRoster(intent, o);
  expect(s.schema_version).toBe(2);
  expect(s.eligibility_settings).toEqual({
    tournament_type: 'MTT',
    game_variant: 'nlh',
    pineapple_holdem: false,
    bomb_pot_enabled: false,
    max_players: 9,
    hole_cards_per_player: 2,
    deck_size: 52,
    board_cards: 5,
    maximum_dealable_seats: 23,
  });
  expect(Object.isFrozen(s.eligibility_settings)).toBe(true);
  const old = { ...s, schema_version: 1 } as unknown as MTTPreReserveSnapshot;
  expect(() => originalMTTRosterPayload(old, intent)).toThrow('schema_unresolved');
  expect(() =>
    validateMTTOriginalRosterAssociation(s, old as unknown as MTTOriginalRosterAssociation, intent)
  ).toThrow('association_unresolved');
});
test('every saved v2 eligibility field is required and must match original', () => {
  const s = snapshotMTTPreReserveRoster(intent, observation());
  for (const key of Object.keys(s.eligibility_settings)) {
    for (const mode of ['missing', 'changed']) {
      const settings: Record<string, unknown> = { ...s.eligibility_settings };
      if (mode === 'missing') delete settings[key];
      else settings[key] = 'changed';
      expect(() =>
        validateMTTOriginalRosterAssociation(
          s,
          { ...s, eligibility_settings: settings } as unknown as MTTOriginalRosterAssociation,
          intent
        )
      ).toThrow('eligibility_settings');
    }
  }
  expect(() =>
    validateMTTOriginalRosterAssociation(
      s,
      { ...s, eligibility_settings: undefined } as unknown as MTTOriginalRosterAssociation,
      intent
    )
  ).toThrow('eligibility_settings');
});
test('frozen runtime settings match saved SQL settings before actuation', () => {
  const o = observation(),
    s = snapshotMTTPreReserveRoster(intent, o),
    frozen = freezeMTTEffectiveSettings(o.table);
  assertMTTCapturedSettings(frozen, s.eligibility_settings);
  for (const key of ['max_players', 'game_variant', 'pineapple_holdem', 'bomb_pot_enabled'])
    expect(() =>
      assertMTTCapturedSettings({ ...frozen, [key]: 'changed' }, s.eligibility_settings)
    ).toThrow('effective_settings_changed');
  expect(() => assertMTTCapturedSettings(null, s.eligibility_settings)).toThrow(
    'effective_settings_missing'
  );
});
