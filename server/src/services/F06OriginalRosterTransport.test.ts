const settings = {
  tournament_type: 'MTT',
  game_variant: 'nlh',
  pineapple_holdem: false,
  bomb_pot_enabled: false,
  max_players: 9,
  hole_cards_per_player: 2,
  deck_size: 52,
  board_cards: 5,
  maximum_dealable_seats: 23,
} as const;
import { originalRosterAdmission } from './F06OriginalRosterAdmission.js';
import { captureMTTRosterBeforeReserve } from '../engine/MTTPreReserveRoster.js';
import { F06HandPermit } from './F06HandPermit.js';
import { test, expect } from 'vitest';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import { retainOriginalRoster, decodeOriginalRoster } from './F06OriginalRosterTransport.js';
const id = (n: any) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const identity = {
    admission_id: id(1),
    tournament_id: id(2),
    table_id: id(3),
    lifecycle: '1',
    lease_generation: id(4),
    custody_id: id(5),
  };
  let owner = true,
    admitted = false,
    next = 10,
    intent = null as any,
    loseAdmission = false,
    loseAllocation = false,
    mode = null as any;
  const calls: any[] = [];
  const rpc = async (name: any, input: any) => {
    calls.push([name, { ...input }]);
    if (mode) return mode(name, input);
    if (name === 'fn_f06_resolve_engine_admission')
      return {
        data: {
          ok: true,
          ...identity,
          state: admitted ? 'ACTIVE' : 'ELIGIBLE',
          revision: '1',
          protocol_epoch: '1',
          enrollment_token: 'a'.repeat(64),
        },
        error: null,
      };
    if (name === 'fn_f06_register_engine_admission') {
      admitted = true;
      if (loseAdmission) {
        loseAdmission = false;
        return { data: null, error: 'lost' };
      }
      return { data: { ok: true, ...identity, state: 'ACTIVE', revision: '1' }, error: null };
    }
    if (name === 'fn_f06_resolve_original_intent') return { data: intent, error: null };
    if (name === 'fn_f06_allocate_original_intent') {
      intent = {
        ok: true,
        ...identity,
        state: 'INTENT',
        permit_id: input.p_permit_id,
        hand_number: '1000001',
        admission_revision: '1',
      };
      if (loseAllocation) {
        loseAllocation = false;
        return { data: null, error: 'lost' };
      }
      return { data: intent, error: null };
    }
    throw Error(name);
  };
  const session = new F06OriginalIntentSession(
    identity,
    rpc,
    () => owner,
    () => id(next++)
  );
  return {
    session,
    calls,
    identity,
    setOwner: (v: any) => (owner = v),
    loseAdmission: () => (loseAdmission = true),
    loseAllocation: () => (loseAllocation = true),
    setMode: (f: any) => (mode = f),
    setIntent: (f: any) => (intent = f),
    allocation: () => intent,
  };
}

const rows = () =>
  [1, 2].map((n) => ({
    user_id: id(100 + n),
    participant_id: id(200 + n),
    participant_registered_at: '2026-09-14T12:00:00.123456Z',
    participant_rebuys: 0,
    table_id: id(3),
    seat_id: id(300 + n),
    seat_number: n,
    occupancy_id: id(400 + n),
    joined_at: '2026-09-14T12:00:00.123456Z',
    stack: 100.25,
  }));
async function ready() {
  const f = fixture();
  await f.session.admit();
  const intent = await f.session.allocate();
  const snapshot: any = {
    kind: 'proposal_only',
    schema_version: 2,
    eligibility_settings: { ...settings },
    profile: 'CLUB_ARENA_ONLINE_MTT_ENTRY_V1:ordinary_nlh',
    intent: { ...intent },
    complete_roster: rows(),
  };
  const input = Object.fromEntries(Object.entries(intent).map(([k, v]) => ['p_' + k, v]));
  const reply = () => ({
    ok: true,
    state: 'reserved',
    tournament_id: intent.tournament_id,
    table_id: intent.table_id,
    permit_id: intent.permit_id,
    generation: intent.lease_generation,
    custody_id: intent.custody_id,
    lifecycle: intent.lifecycle,
    hand_number: intent.hand_number,
    original_roster: {
      kind: 'saved_original_roster',
      intent: { ...intent },
      schema_version: 2,
      eligibility_settings: { ...settings },
      profile: snapshot.profile,
      permit_id: intent.permit_id,
      tournament_id: intent.tournament_id,
      table_id: intent.table_id,
      table_lifecycle: intent.lifecycle,
      hand_number: intent.hand_number,
      complete_roster: rows(),
      permit_state: 'reserved',
      evidence_id: null,
      entry_enrollments: [
        {
          source_ref: {
            rail: 'purchase',
            key_domain: 'tournament_registration_v1',
            idempotency_key: 'original',
          },
          participant_id: id(201),
        },
      ],
    },
  });
  return { ...f, intent, snapshot, input, reply };
}
test('actual ten-field ABI and saved all-nine identity provenance', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  f.setMode(async (name: any, args: any) => {
    expect(name).toBe('fn_f06_begin_hand_with_intent');
    expect(Object.keys(args)).toHaveLength(10);
    for (const [k, v] of Object.entries(f.intent)) expect(args['p_' + k]).toBe(v);
    return { data: f.reply(), error: null };
  });
  const result = await f.session.begin(f.input);
  expect('requestBoundOnly' in result.originalRoster!).toBe(false);
  expect(result.originalRoster!.association.intent).not.toBe(f.intent);
  expect(result.originalRoster!.association.intent).toEqual(f.intent);
  expect(Object.isFrozen(result.originalRoster!.association.complete_roster[0])).toBe(true);
});
test('lost transport retains exact request object despite later source mutation', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  const requests: any[] = [];
  f.setMode(async (_: any, args: any) => {
    requests.push(args.p_expected_complete_roster);
    return requests.length === 1 ? { error: 'lost', data: null } : { error: null, data: f.reply() };
  });
  await expect(f.session.begin(f.input)).rejects.toThrow();
  f.snapshot.complete_roster[0].stack = 300;
  f.snapshot.complete_roster.push(rows()[0]);
  await f.session.begin(f.input);
  expect(requests[0]).toBe(requests[1]);
  expect(requests[1].complete_roster).toHaveLength(2);
  expect(requests[1].complete_roster[0].stack).toBe(100.25);
  expect(() => f.session.bindOriginalRoster(f.snapshot)).toThrow();
});
test('owner replacement during physical call refuses result', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  f.setMode(async () => {
    f.setOwner(false);
    return { data: f.reply(), error: null };
  });
  await expect(f.session.begin(f.input)).rejects.toThrow('owner');
});
for (const key of [
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'admission_revision',
  'permit_id',
  'hand_number',
])
  test('rejects changed original ' + key, async () => {
    const f = await ready();
    f.snapshot.intent[key] = 'changed';
    expect(() => f.session.bindOriginalRoster(f.snapshot)).toThrow();
  });
for (const field of [
  'generation',
  'custody_id',
  'tournament_id',
  'table_id',
  'permit_id',
  'lifecycle',
  'hand_number',
])
  test('rejects canonical response ' + field, async () => {
    const f = await ready();
    f.session.bindOriginalRoster(f.snapshot);
    const r: any = f.reply();
    r[field] = 'changed';
    f.setMode(async () => ({ data: r, error: null }));
    await expect(f.session.begin(f.input)).rejects.toThrow();
  });
for (const mode of [
  'missing',
  'legacy',
  'expanded',
  'truncated',
  'evidence',
  'terminal',
  'participant',
  'enrollment',
  'duplicate',
  'schema',
  'profile',
])
  test('refuses ' + mode + ' association', async () => {
    const f = await ready();
    f.session.bindOriginalRoster(f.snapshot);
    const r: any = f.reply(),
      s = r.original_roster;
    if (mode === 'missing') delete r.original_roster;
    if (mode === 'legacy')
      r.original_roster = { kind: 'unresolved', reason: 'legacy_permit_without_original_roster' };
    if (mode === 'expanded') s.complete_roster.push(rows()[0]);
    if (mode === 'truncated') s.complete_roster.pop();
    if (mode === 'evidence') s.evidence_id = id(8);
    if (mode === 'terminal') s.permit_state = 'never_started';
    if (mode === 'participant') s.complete_roster[0].participant_id = id(9);
    if (mode === 'enrollment') s.entry_enrollments[0].participant_id = id(9);
    if (mode === 'duplicate') s.entry_enrollments.push(s.entry_enrollments[0]);
    if (mode === 'schema') s.schema_version = 1;
    if (mode === 'profile') s.profile = 'other';
    f.setMode(async () => ({ data: r, error: null }));
    await expect(f.session.begin(f.input)).rejects.toThrow();
  });
test('normalizes SQL timestamp zone/microseconds and decimal text without mutating original', async () => {
  const f = await ready(),
    binding = retainOriginalRoster(f.snapshot, f.intent);
  const r: any = f.reply();
  for (const row of r.original_roster.complete_roster) {
    row.joined_at = '2026-09-14T07:00:00.123456-05:00';
    row.participant_registered_at = '2026-09-14T12:00:00.123456+00:00';
    row.stack = '100.2500';
    row.participant_rebuys = '0';
    row.seat_number = String(row.seat_number);
  }
  const d = decodeOriginalRoster(binding, r, f.intent);
  expect(d.association.complete_roster[0].joined_at).toBe('2026-09-14T12:00:00.123456Z');
  expect(d.association.complete_roster[0].stack).toBe(100.25);
  r.original_roster.complete_roster[0].joined_at = '2026-09-14T12:00:00.123457Z';
  expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
});
for (const value of ['100.250000000000000001', 'NaN', 'Infinity', 9007199254740992, '0x64', null])
  test('refuses changed or unsafe numeric ' + value, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent);
    const r: any = f.reply();
    r.original_roster.complete_roster[0].stack = value;
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
test('cannot inject request or revise admission revision at begin', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  await expect(f.session.begin({ ...f.input, p_expected_complete_roster: {} })).rejects.toThrow();
  await expect(f.session.begin({ ...f.input, p_admission_revision: '2' })).rejects.toThrow();
});
test('cannot bind after unbound original begin attempt', async () => {
  const f = await ready();
  f.setMode(async () => ({ data: null, error: 'lost' }));
  await expect(f.session.begin(f.input)).rejects.toThrow();
  expect(() => f.session.bindOriginalRoster(f.snapshot)).toThrow('late_binding');
});

for (const field of [
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'admission_revision',
  'permit_id',
  'hand_number',
])
  test('current identity replacement ' + field, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent);
    expect(() =>
      decodeOriginalRoster(binding, f.reply(), { ...f.intent, [field]: 'changed' })
    ).toThrow();
  });
for (const field of [
  'user_id',
  'participant_id',
  'participant_registered_at',
  'participant_rebuys',
  'table_id',
  'seat_id',
  'seat_number',
  'occupancy_id',
  'joined_at',
  'stack',
])
  test('saved roster anchor replacement ' + field, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    r.original_roster.complete_roster[0][field] = 'changed';
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
test('real permit keeps unknown on unresolved roster, retries original and preserves number refusal', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  const { admission_id, admission_revision, ...identity } = f.intent;
  const permit = new F06HandPermit(
    identity,
    (_, input) => f.session.begin(input),
    () => f.session.canStart()
  );
  const bad: any = f.reply();
  delete bad.original_roster;
  f.setMode(async () => ({ data: bad, error: null }));
  await expect(permit.reserve()).rejects.toThrow();
  expect(permit.recoveryState()).toBe('unknown');
  expect(() =>
    permit.start(() => {
      throw Error('actuated');
    })
  ).toThrow('f06_start_unproven');
  f.setMode(async () => ({ data: f.reply(), error: null }));
  await permit.reserve();
  expect(permit.recoveryState()).toBe('reserved');
  const g = await ready();
  g.session.bindOriginalRoster(g.snapshot);
  const { admission_id: a, admission_revision: b, ...other } = g.intent;
  const refused = new F06HandPermit(
    other,
    (_, input) => g.session.begin(input),
    () => true
  );
  g.setMode(async () => ({ data: { ok: false, reason: 'hand_number_already_used' }, error: null }));
  await expect(refused.reserve()).rejects.toThrow('hand_number_already_used');
  expect(refused.knownNumberRefusal()).toBe(true);
});

for (const field of [
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'admission_revision',
  'permit_id',
  'hand_number',
])
  test('saved identity must echo ' + field, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    delete r.original_roster.intent[field];
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
    r.original_roster.intent[field] = 'changed';
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
const refs = (participant: string) => [
  { rail: 'purchase', key_domain: 'tournament_chip_purchase', idempotency_key: 'original-key' },
  {
    rail: 'ticket',
    entitlement_id: id(701),
    ticket_id: id(702),
    source_ledger_id: id(703),
    registration_id: participant,
  },
  {
    rail: 'horse_wallet',
    entitlement_id: id(704),
    source_ledger_id: id(705),
    registration_id: participant,
  },
  { rail: 'configured_zero_cost_horse', registration_id: participant },
];
for (let index = 0; index < 4; index++)
  test('decodes actual rail ' + index, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    r.original_roster.entry_enrollments = [
      { participant_id: id(201), source_ref: refs(id(201))[index] },
    ];
    const result = decodeOriginalRoster(binding, r, f.intent);
    expect(result.entryEnrollments[0].source_ref).toEqual(refs(id(201))[index]);
    expect(Object.isFrozen(result.entryEnrollments[0].source_ref)).toBe(true);
  });
for (const mode of [
  'unknown',
  'missing',
  'foreign-registration',
  'extra',
  'duplicate-participant',
  'old-purchase-only',
])
  test('refuses rail ' + mode, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const e = { participant_id: id(201), source_ref: refs(id(201))[1] as any };
    r.original_roster.entry_enrollments = [e];
    if (mode === 'unknown') e.source_ref.rail = 'satellite_seat';
    if (mode === 'missing') delete e.source_ref.source_ledger_id;
    if (mode === 'foreign-registration') e.source_ref.registration_id = id(202);
    if (mode === 'extra') e.source_ref.fabricated = 'x';
    if (mode === 'duplicate-participant')
      r.original_roster.entry_enrollments.push({
        participant_id: id(201),
        source_ref: refs(id(201))[2],
      });
    if (mode === 'old-purchase-only') {
      delete r.original_roster.entry_enrollments;
      r.original_roster.purchase_enrollments = [];
    }
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
function observation(f: any): any {
  const seats = rows().map((row) => ({
    ...row,
    seat_id: row.seat_id,
    seat_joined_at: row.joined_at,
    left_at: null,
    entry_hold: null,
  }));
  return {
    seats,
    selected: seats,
    participants: rows().map((r) => ({
      id: r.participant_id,
      user_id: r.user_id,
      tournament_id: f.intent.tournament_id,
      table_id: r.table_id,
      seat_number: r.seat_number,
      registered_at: r.participant_registered_at,
      rebuys: r.participant_rebuys,
      status: 'playing',
    })),
    waitingForBB: new Set(),
    swapHeld: new Set(),
    table: {
      id: f.intent.table_id,
      tournament_id: f.intent.tournament_id,
      f06_lifecycle: f.intent.lifecycle,
      max_players: 9,
      game_variant: 'nlh',
      pineapple_holdem: false,
      bomb_pot_enabled: false,
    },
    tournament: { id: f.intent.tournament_id, tournament_type: 'MTT' },
    effectiveVariant: 'nlh',
    ordinaryHand: true,
  };
}
test('factory uses actual Lease capture, original Session and same permit saved evidence', async () => {
  const f = await ready(),
    o = observation(f),
    capture = captureMTTRosterBeforeReserve(o);
  let current = true;
  const install = originalRosterAdmission(
    f.session,
    () => current,
    async () => ({ data: null, error: null }),
    async () => o
  );
  const permit = await install.factory(f.intent.hand_number, capture);
  expect(() => install.boundary!.saved(permit)).toThrow();
  f.setMode(async () => ({ data: f.reply(), error: null }));
  await permit.reserve();
  const saved = install.boundary!.saved(permit);
  expect(saved.intent).toEqual(f.intent);
  expect(saved.association.complete_roster).toEqual(rows());
  const other = new F06HandPermit(
    permit.binding,
    async () => ({ data: f.reply(), error: null }),
    () => true
  );
  await other.reserve();
  expect(() => install.boundary!.saved(other)).toThrow('missing');
  current = false;
  expect(() => install.boundary!.saved(permit)).toThrow('owner');
});
test('factory lost response retries same captured request and updates only original permit', async () => {
  const f = await ready(),
    o = observation(f),
    capture = captureMTTRosterBeforeReserve(o),
    requests: any[] = [];
  const install = originalRosterAdmission(
      f.session,
      () => true,
      async () => ({ data: null, error: null }),
      async () => o
    ),
    permit = await install.factory(f.intent.hand_number, capture);
  f.setMode(async (_: any, input: any) => {
    requests.push(input.p_expected_complete_roster);
    return requests.length === 1 ? { data: null, error: 'lost' } : { data: f.reply(), error: null };
  });
  await expect(permit.reserve()).rejects.toThrow();
  o.seats[0].stack = 900;
  expect(() => install.boundary!.saved(permit)).toThrow();
  await permit.reserve();
  expect(requests[0]).toBe(requests[1]);
  expect(install.boundary!.saved(permit).association.complete_roster[0].stack).toBe(100.25);
});
test('factory rejects owner replacement during response and mismatched capture installation', async () => {
  const f = await ready(),
    o = observation(f),
    capture = captureMTTRosterBeforeReserve(o);
  let current = true;
  const install = originalRosterAdmission(
    f.session,
    () => current,
    async () => ({ data: null, error: null }),
    async () => o
  );
  expect(() => install.factory(f.intent.hand_number)).toThrow('mismatch');
  const permit = await install.factory(f.intent.hand_number, capture);
  f.setMode(async () => {
    current = false;
    return { data: f.reply(), error: null };
  });
  await expect(permit.reserve()).rejects.toThrow('owner');
  expect(permit.recoveryState()).toBe('unknown');
});
test('unactivated installation keeps legacy factory and completion route', async () => {
  const f = await ready();
  const install = originalRosterAdmission(
    f.session,
    () => true,
    async () => ({ data: null, error: null })
  );
  expect(install.boundary).toBeUndefined();
  const permit = await install.factory(f.intent.hand_number);
  f.setMode(async (_: any, input: any) => {
    expect(input.p_expected_complete_roster).toBeUndefined();
    return { data: f.reply(), error: null };
  });
  await permit.reserve();
  expect(permit.recoveryState()).toBe('reserved');
});

test('version1 request is refused without relabeling or transport', async () => {
  const f = await ready();
  f.snapshot.schema_version = 1;
  const before = f.calls.length;
  expect(() => f.session.bindOriginalRoster(f.snapshot)).toThrow();
  expect(f.calls.length).toBe(before);
  expect(f.snapshot.schema_version).toBe(1);
});
for (const field of Object.keys(settings))
  test('version2 saved eligibility ' + field, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    delete r.original_roster.eligibility_settings[field];
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
    r.original_roster.eligibility_settings[field] = 'changed';
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
test('exact satellite source and award place are read, not inferred from target', async () => {
  const f = await ready(),
    binding = retainOriginalRoster(f.snapshot, f.intent),
    r: any = f.reply();
  r.original_roster.entry_enrollments = [
    {
      participant_id: id(201),
      source_ref: {
        rail: 'direct_satellite_seat',
        entitlement_id: id(801),
        source_satellite_id: id(802),
        award_place: 1,
        source_ledger_id: id(803),
        registration_id: id(201),
      },
    },
  ];
  const decoded = decodeOriginalRoster(binding, r, f.intent);
  expect(decoded.entryEnrollments[0].source_ref).toEqual(
    r.original_roster.entry_enrollments[0].source_ref
  );
  for (const bad of [0, -1, 1.5, '1', null]) {
    r.original_roster.entry_enrollments[0].source_ref.award_place = bad;
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  }
});
test('settings stay original across unknown retry and later source mutation', async () => {
  const f = await ready();
  f.session.bindOriginalRoster(f.snapshot);
  let seen: any;
  f.setMode(async (_: any, args: any) => {
    if (!seen) {
      seen = args.p_expected_complete_roster;
      return { data: null, error: 'lost' };
    }
    expect(args.p_expected_complete_roster).toBe(seen);
    expect(seen.eligibility_settings.max_players).toBe(9);
    return { data: f.reply(), error: null };
  });
  await expect(f.session.begin(f.input)).rejects.toThrow();
  f.snapshot.eligibility_settings.max_players = 8;
  await f.session.begin(f.input);
  expect(() => f.session.bindOriginalRoster(f.snapshot)).toThrow();
});

const registrationSources = (participant: string) => [
  {
    rail: 'registration_wallet',
    registration_id: participant,
    entitlement_id: id(901),
    source_ledger_id: id(902),
    diamond_ledger_id: null,
    diamond_custody_id: null,
  },
  {
    rail: 'registration_diamonds',
    registration_id: participant,
    entitlement_id: null,
    source_ledger_id: null,
    diamond_ledger_id: '9007199254740993',
    diamond_custody_id: id(903),
  },
  {
    rail: 'registration_zero_cost',
    registration_id: participant,
    entitlement_id: null,
    source_ledger_id: null,
    diamond_ledger_id: null,
    diamond_custody_id: null,
  },
];
for (let index = 0; index < 3; index++)
  test('new explicit registration source ' + index, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const source = registrationSources(id(201))[index];
    r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
    const d = decodeOriginalRoster(binding, r, f.intent);
    expect(d.entryEnrollments[0].source_ref).toEqual(source);
    expect(Object.isFrozen(d.entryEnrollments[0].source_ref)).toBe(true);
    source.registration_id = id(202);
    expect(d.entryEnrollments[0].source_ref).not.toEqual(source);
  });
for (let index = 0; index < 3; index++)
  for (const field of [
    'registration_id',
    'entitlement_id',
    'source_ledger_id',
    'diamond_ledger_id',
    'diamond_custody_id',
  ])
    test('registration ' + index + ' requires field ' + field, async () => {
      const f = await ready(),
        binding = retainOriginalRoster(f.snapshot, f.intent),
        r: any = f.reply();
      const source: any = registrationSources(id(201))[index];
      delete source[field];
      r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
      expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
    });
for (let index = 0; index < 3; index++)
  test('registration ' + index + ' rejects foreign registration and extra field', async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const source: any = registrationSources(id(202))[index];
    r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
    source.registration_id = id(201);
    source.synthetic_request_id = id(999);
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
for (const [index, field] of [
  [0, 'diamond_ledger_id'],
  [0, 'diamond_custody_id'],
  [1, 'entitlement_id'],
  [1, 'source_ledger_id'],
  [2, 'entitlement_id'],
  [2, 'source_ledger_id'],
  [2, 'diamond_ledger_id'],
  [2, 'diamond_custody_id'],
] as const)
  test('inapplicable funding must be null ' + index + ' ' + field, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const source: any = registrationSources(id(201))[index];
    source[field] = field === 'diamond_ledger_id' ? '1' : id(990);
    r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
for (const bad of [
  Number('9007199254740993'),
  1,
  null,
  '',
  '01',
  '-0',
  '+1',
  '1.0',
  '1e3',
  ' 1',
  '9223372036854775808',
  '-9223372036854775809',
])
  test('Diamond ID requires canonical bigint text ' + String(bad), async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const source: any = registrationSources(id(201))[1];
    source.diamond_ledger_id = bad;
    r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
    expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  });
for (const ledger of ['9007199254740993', '9223372036854775807', '-9223372036854775808', '0'])
  test('Diamond bigint text is preserved exactly ' + ledger, async () => {
    const f = await ready(),
      binding = retainOriginalRoster(f.snapshot, f.intent),
      r: any = f.reply();
    const source: any = registrationSources(id(201))[1];
    source.diamond_ledger_id = ledger;
    r.original_roster.entry_enrollments = [{ participant_id: id(201), source_ref: source }];
    const d = decodeOriginalRoster(binding, r, f.intent);
    expect(d.entryEnrollments[0].source_ref).toEqual(source);
  });
test('keyed and registration aliases cannot both enroll one participant', async () => {
  const f = await ready(),
    binding = retainOriginalRoster(f.snapshot, f.intent),
    r: any = f.reply();
  r.original_roster.entry_enrollments.push({
    participant_id: id(201),
    source_ref: registrationSources(id(201))[0],
  });
  expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
});
test('new registration source does not relax reserved/current identity or settings', async () => {
  const f = await ready(),
    binding = retainOriginalRoster(f.snapshot, f.intent),
    r: any = f.reply();
  r.original_roster.entry_enrollments = [
    { participant_id: id(201), source_ref: registrationSources(id(201))[2] },
  ];
  r.original_roster.permit_state = 'accepted';
  expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
  r.original_roster.permit_state = 'reserved';
  r.original_roster.intent.admission_revision = '99';
  expect(() => decodeOriginalRoster(binding, r, f.intent)).toThrow();
});
