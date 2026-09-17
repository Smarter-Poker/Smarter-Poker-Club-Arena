import type { SeatedPlayer } from '../types.js';
import type { OriginalIntentIdentity } from '../services/F06OriginalIntentSession.js';
import { holeCardCount, deckSizeFor, maxSeatsFor } from './VariantRules.js';

/** Inert projection only: neither a receipt nor permission to prepare/deal. */
export interface MTTEntryRosterRow {
  user_id: string;
  participant_id: string;
  participant_registered_at: string;
  participant_rebuys: number;
  table_id: string;
  seat_id: string;
  seat_number: number;
  occupancy_id: string;
  joined_at: string;
  stack: number;
}
export interface MTTRosterObservation {
  /** Complete current seat read, not the pre-rest selected subset. */
  seats: readonly (SeatedPlayer & { left_at: string | null; entry_hold: string | null })[];
  /** Same canonical observation; no latest-user-wide participant lookup. */
  participants: readonly {
    id: string;
    user_id: string;
    tournament_id: string;
    table_id: string;
    seat_number: number;
    registered_at: string;
    rebuys: number;
    status: string;
  }[];
  selected: readonly SeatedPlayer[];
  waitingForBB: ReadonlySet<string>;
  swapHeld: ReadonlySet<string>;
  table: {
    id: string;
    tournament_id: string | null;
    f06_lifecycle: string;
    max_players: number;
    game_variant: string | null;
    pineapple_holdem: boolean | null;
    bomb_pot_enabled: boolean | null;
  };
  tournament: { id: string; tournament_type: string | null };
  /** Must be resolved before reservation; no game_variant || nlh fallback. */
  effectiveVariant: string | null;
  ordinaryHand: boolean;
}
/** Exact Backlog0064 ROSTER-ABI-V2.ts settings contract. */
export interface MTTRosterEligibilitySettingsV2 {
  readonly tournament_type: 'MTT';
  readonly game_variant: 'nlh';
  readonly pineapple_holdem: false;
  readonly bomb_pot_enabled: false;
  readonly max_players: number;
  readonly hole_cards_per_player: 2;
  readonly deck_size: 52;
  readonly board_cards: 5;
  readonly maximum_dealable_seats: 23;
}
export interface MTTPreReserveSnapshot {
  readonly kind: 'proposal_only';
  readonly schema_version: 2;
  readonly intent: Readonly<OriginalIntentIdentity>;
  readonly profile: 'CLUB_ARENA_ONLINE_MTT_ENTRY_V1:ordinary_nlh';
  readonly eligibility_settings: Readonly<MTTRosterEligibilitySettingsV2>;
  readonly complete_roster: readonly Readonly<MTTEntryRosterRow>[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (reason: string): never => {
  throw new Error('mtt_roster_' + reason);
};
const timestamp = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s));
/** Call under acquireSeatBoundary after hand-number allocation, before reserveF06Hand.
 * Retain returned object in the existing original permit/session invocation closure.
 * Retry must reuse that object; this function does not allocate or rotate permits. */
export function snapshotMTTPreReserveRoster(
  intent: OriginalIntentIdentity,
  o: MTTRosterObservation
): MTTPreReserveSnapshot {
  for (const k of [
    'admission_id',
    'tournament_id',
    'table_id',
    'lease_generation',
    'custody_id',
    'permit_id',
  ] as const)
    if (!uuid.test(intent[k])) fail('identity');
  for (const k of ['lifecycle', 'admission_revision', 'hand_number'] as const)
    if (!/^[1-9][0-9]{0,18}$/.test(intent[k]) || BigInt(intent[k]) > 9223372036854775807n)
      fail('identity');
  if (
    o.table.id !== intent.table_id ||
    o.table.tournament_id !== intent.tournament_id ||
    o.tournament.id !== intent.tournament_id ||
    o.table.f06_lifecycle !== intent.lifecycle
  )
    fail('scope');
  if (holeCardCount('nlh') !== 2 || deckSizeFor('nlh') !== 52 || maxSeatsFor('nlh') !== 23)
    fail('deck_rules_changed');
  const rows = projectMTTRosterObservation(o);
  return Object.freeze({
    kind: 'proposal_only',
    schema_version: 2,
    intent: Object.freeze({ ...intent }),
    profile: 'CLUB_ARENA_ONLINE_MTT_ENTRY_V1:ordinary_nlh',
    eligibility_settings: Object.freeze({
      tournament_type: 'MTT',
      game_variant: 'nlh',
      pineapple_holdem: false,
      bomb_pot_enabled: false,
      max_players: o.table.max_players,
      hole_cards_per_player: 2,
      deck_size: 52,
      board_cards: 5,
      maximum_dealable_seats: 23,
    }),
    complete_roster: Object.freeze(rows.map((r) => Object.freeze(r))),
  });
}
/** Pure eligibility check can run before original permit allocation. */
function projectMTTRosterObservation(o: MTTRosterObservation): MTTEntryRosterRow[] {
  if (
    o.tournament.tournament_type !== 'MTT' ||
    o.table.game_variant !== 'nlh' ||
    o.effectiveVariant !== 'nlh' ||
    o.table.pineapple_holdem !== false ||
    o.table.bomb_pot_enabled !== false ||
    o.ordinaryHand !== true
  )
    fail('unsupported_profile');
  if (!Number.isInteger(o.table.max_players) || o.table.max_players < 2 || o.table.max_players > 10)
    fail('capacity');
  if (
    o.seats.length > o.table.max_players ||
    o.participants.length > o.table.max_players ||
    o.selected.length > o.table.max_players
  )
    fail('capacity');
  const rows: MTTEntryRosterRow[] = [],
    users = new Set<string>(),
    seats = new Set<number>();
  const participantIds = new Set<string>(),
    occupancyIds = new Set<string>(),
    seatIds = new Set<string>();
  for (const s of o.seats) {
    if (
      !uuid.test(s.user_id) ||
      !Number.isFinite(s.stack) ||
      s.stack < 0 ||
      !Number.isInteger(s.seat_number) ||
      s.seat_number < 1 ||
      s.seat_number > o.table.max_players ||
      users.has(s.user_id) ||
      seats.has(s.seat_number)
    )
      fail('seat');
    users.add(s.user_id);
    seats.add(s.seat_number);
    if (s.left_at !== null) fail('stale_seat');
    if (s.stack === 0) continue;
    // Tournament sit-outs remain eligible and post natural blinds. Entry and
    // swap holds cannot justify omitted positive seats in0062; a persisted cash hold is
    // unresolved, never silently converted into tournament eligibility.
    if (s.entry_hold !== null && s.entry_hold !== 'moved') fail('entry_hold_unresolved');
    if (o.waitingForBB.has(s.user_id) || o.swapHeld.has(s.user_id)) fail('local_hold_unqualified');
    const matches = o.participants.filter((p) => p.user_id === s.user_id);
    if (matches.length !== 1) fail('participant');
    const p = matches[0];
    if (
      p.tournament_id !== o.table.tournament_id ||
      p.table_id !== o.table.id ||
      p.seat_number !== s.seat_number ||
      p.status !== 'playing' ||
      !uuid.test(p.id) ||
      !timestamp(p.registered_at) ||
      !Number.isSafeInteger(p.rebuys) ||
      p.rebuys < 0 ||
      !s.seat_id ||
      !uuid.test(s.seat_id) ||
      !s.occupancy_id ||
      !uuid.test(s.occupancy_id) ||
      !timestamp(s.seat_joined_at)
    )
      fail('participant_occupancy');
    if (participantIds.has(p.id) || occupancyIds.has(s.occupancy_id!) || seatIds.has(s.seat_id!))
      fail('duplicate_anchor');
    participantIds.add(p.id);
    occupancyIds.add(s.occupancy_id!);
    seatIds.add(s.seat_id!);
    rows.push({
      user_id: s.user_id,
      participant_id: p.id,
      participant_registered_at: p.registered_at,
      participant_rebuys: p.rebuys,
      table_id: o.table.id,
      seat_id: s.seat_id!,
      seat_number: s.seat_number,
      occupancy_id: s.occupancy_id!,
      joined_at: s.seat_joined_at!,
      stack: s.stack,
    });
  }
  rows.sort((a, b) => a.seat_number - b.seat_number);
  if (
    rows.length < 2 ||
    rows.length > maxSeatsFor('nlh') ||
    rows.length * holeCardCount('nlh') + 5 > deckSizeFor('nlh')
  )
    fail('deck_capacity');
  if (
    o.selected.length !== rows.length ||
    new Set(o.selected.map((s) => s.user_id)).size !== rows.length ||
    rows.some(
      (r) =>
        !o.selected.some(
          (s) =>
            s.user_id === r.user_id &&
            s.seat_number === r.seat_number &&
            s.occupancy_id === r.occupancy_id &&
            s.seat_id === r.seat_id &&
            s.seat_joined_at === r.joined_at &&
            s.stack === r.stack
        )
    )
  )
    fail('selected_changed');
  return rows;
}

/** Existing retained invocation calls this before retry. No resnapshot on loss. */
export function originalMTTRosterPayload(
  snapshot: MTTPreReserveSnapshot,
  expected: OriginalIntentIdentity
): readonly Readonly<MTTEntryRosterRow>[] {
  if (snapshot.schema_version !== 2 || !snapshot.eligibility_settings) fail('schema_unresolved');
  for (const key of Object.keys(snapshot.intent) as (keyof OriginalIntentIdentity)[])
    if (snapshot.intent[key] !== expected[key]) fail('original_intent_changed');
  return snapshot.complete_roster;
}

/** Internal adapter contract for the saved original association. This is not an
 * installed wire ABI. Connected must decode its actual owned response into it,
 * retaining all original identity checks; callers cannot synthesize acceptance.
 * Lifecycle/hand/permit/roster correspond to0059 persisted association columns.
 */
export interface MTTOriginalRosterAssociation {
  readonly intent: Readonly<OriginalIntentIdentity>;
  readonly schema_version: 2;
  readonly profile: MTTPreReserveSnapshot['profile'];
  readonly eligibility_settings: Readonly<MTTRosterEligibilitySettingsV2>;
  readonly complete_roster: readonly Readonly<MTTEntryRosterRow>[];
}
const rosterKeys = [
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
] as const;
/** Consume only the saved association returned by the original canonical call.
 * Exact current intent is checked again before preparation and final start.
 * No permit state is advanced here. Missing legacy association stays unresolved.
 */
export function validateMTTOriginalRosterAssociation(
  snapshot: MTTPreReserveSnapshot,
  saved: MTTOriginalRosterAssociation | null | undefined,
  current: OriginalIntentIdentity
): readonly Readonly<MTTEntryRosterRow>[] {
  originalMTTRosterPayload(snapshot, current);
  if (
    !saved ||
    saved.schema_version !== snapshot.schema_version ||
    saved.profile !== snapshot.profile
  )
    fail('association_unresolved');
  if (!saved!.eligibility_settings) fail('eligibility_settings');
  for (const key of Object.keys(
    snapshot.eligibility_settings
  ) as (keyof MTTRosterEligibilitySettingsV2)[])
    if (saved!.eligibility_settings[key] !== snapshot.eligibility_settings[key])
      fail('eligibility_settings');
  for (const key of Object.keys(snapshot.intent) as (keyof OriginalIntentIdentity)[])
    if (saved!.intent?.[key] !== snapshot.intent[key]) fail('association_identity');
  if (
    !Array.isArray(saved!.complete_roster) ||
    saved!.complete_roster.length !== snapshot.complete_roster.length
  )
    fail('association_roster');
  for (let i = 0; i < snapshot.complete_roster.length; i++) {
    const actual = saved!.complete_roster[i];
    if (!actual || rosterKeys.some((key) => actual[key] !== snapshot.complete_roster[i][key]))
      fail('association_roster');
  }
  // Use our already detached immutable values after exact authoritative readback,
  // never a mutable transport object. This value alone cannot start a hand.
  return snapshot.complete_roster;
}

/** Bind inside the existing original forHand factory, before its first begin.
 * The callback is the original Session transport, not an alternate RPC. Only
 * that owner may implement canonical decoding. This closure retains data only;
 * F06HandPermit/Session continue to own all retry and custody state. */
export function bindMTTOriginalRosterInvocation(
  snapshot: MTTPreReserveSnapshot,
  originalBegin: (request: MTTPreReserveSnapshot) => Promise<MTTOriginalRosterAssociation | null>,
  currentIntent: () => OriginalIntentIdentity
): Readonly<{
  request: MTTPreReserveSnapshot;
  begin: () => Promise<readonly Readonly<MTTEntryRosterRow>[]>;
}> {
  return Object.freeze({
    request: snapshot,
    begin: async () => {
      originalMTTRosterPayload(snapshot, currentIntent());
      const saved = await originalBegin(snapshot);
      return validateMTTOriginalRosterAssociation(snapshot, saved, currentIntent());
    },
  });
}

/** Actual pre-reserve bridge: dealHand captures this before entering the
 * factory, which supplies admission/revision only after admitted.forHand.
 * All mutable engine observations are detached synchronously under its seat
 * boundary. The returned closure has no read of later engine rosters. */
export function captureMTTRosterBeforeReserve(observation: MTTRosterObservation): Readonly<{
  forOriginalIntent: (intent: OriginalIntentIdentity) => MTTPreReserveSnapshot;
}> {
  // Reject eligibility/deck/hold mismatches before the factory can reserve.
  projectMTTRosterObservation(observation);
  const captured: MTTRosterObservation = {
    ...observation,
    table: { ...observation.table },
    tournament: { ...observation.tournament },
    seats: observation.seats.map((s) => ({ ...s })),
    selected: observation.selected.map((s) => ({ ...s })),
    participants: observation.participants.map((p) => ({ ...p })),
    waitingForBB: new Set(observation.waitingForBB),
    swapHeld: new Set(observation.swapHeld),
  };
  let original: MTTPreReserveSnapshot | undefined;
  return Object.freeze({
    forOriginalIntent: (intent: OriginalIntentIdentity) => {
      if (!original) original = snapshotMTTPreReserveRoster(intent, captured);
      originalMTTRosterPayload(original, intent);
      return original;
    },
  });
}

/** Detached settings for one original ordinary hand; no live table aliases. */
export function freezeMTTEffectiveSettings<T extends object>(settings: T): Readonly<T> {
  const captured = structuredClone(settings);
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  };
  freeze(captured);
  return captured;
}

/** Compare the actually frozen engine settings to saved/captured canonical values.
 * This equality check does not itself manufacture canonical SQL evidence. */
export function assertMTTCapturedSettings(
  settings: object | null,
  expected: MTTRosterEligibilitySettingsV2
): void {
  if (!settings) fail('effective_settings_missing');
  const value = settings as Record<string, unknown>;
  for (const key of [
    'game_variant',
    'pineapple_holdem',
    'bomb_pot_enabled',
    'max_players',
  ] as const)
    if (value[key] !== expected[key]) fail('effective_settings_changed');
  if (
    holeCardCount('nlh') !== expected.hole_cards_per_player ||
    deckSizeFor('nlh') !== expected.deck_size ||
    maxSeatsFor('nlh') !== expected.maximum_dealable_seats ||
    expected.board_cards !== 5
  )
    fail('deck_rules_changed');
}
