import type { OriginalIntentIdentity } from './F06OriginalIntentSession.js';
import type {
  MTTPreReserveSnapshot,
  MTTOriginalRosterAssociation,
} from '../engine/MTTPreReserveRoster.js';

const keys = [
  'admission_id',
  'tournament_id',
  'table_id',
  'lifecycle',
  'lease_generation',
  'custody_id',
  'admission_revision',
  'permit_id',
  'hand_number',
] as const;
const profile = 'CLUB_ARENA_ONLINE_MTT_ENTRY_V1:ordinary_nlh';
const settingsKeys = [
  'tournament_type',
  'game_variant',
  'pineapple_holdem',
  'bomb_pot_enabled',
  'max_players',
  'hole_cards_per_player',
  'deck_size',
  'board_cards',
  'maximum_dealable_seats',
] as const;
function assertEligibility(value: unknown): void {
  const s = object(value);
  if (
    Object.keys(s).length !== settingsKeys.length ||
    s.tournament_type !== 'MTT' ||
    s.game_variant !== 'nlh' ||
    s.pineapple_holdem !== false ||
    s.bomb_pot_enabled !== false ||
    !Number.isInteger(s.max_players) ||
    (s.max_players as number) < 2 ||
    (s.max_players as number) > 10 ||
    s.hole_cards_per_player !== 2 ||
    s.deck_size !== 52 ||
    s.board_cards !== 5 ||
    s.maximum_dealable_seats !== 23
  )
    reject();
}

const reject = (): never => {
  throw new Error('f06_original_roster_unproven');
};
const object = (x: unknown): Record<string, unknown> => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return reject();
  return x as Record<string, unknown>;
};
/** Compare decimal values without rounding SQL numeric strings through Number. */
function decimal(x: unknown): string {
  if (typeof x === 'number' && (!Number.isFinite(x) || Math.abs(x) > Number.MAX_SAFE_INTEGER))
    return reject();
  if (typeof x !== 'number' && typeof x !== 'string') return reject();
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(String(x));
  if (!m || String(x).length > 100) return reject();
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '') || '0';
  let exponent = Number(m[4] || 0) - (m[3] || '').length;
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent++;
  }
  return digits === '0' ? '0' : `${m[1] === '-' ? '-' : ''}${digits}e${exponent}`;
}
/** Preserve PostgreSQL microseconds; Date alone would collapse distinct anchors. */
function instant(x: unknown): bigint {
  if (typeof x !== 'string') return reject();
  const m = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]\d\d:\d\d)$/.exec(x);
  if (!m) return reject();
  const local = `${m[1]}T${m[2]}`;
  const milliseconds = Date.parse(local + 'Z');
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== local)
    return reject();
  const zone = m[4];
  const hours = zone === 'Z' ? 0 : Number(zone.slice(1, 3));
  const minutes = zone === 'Z' ? 0 : Number(zone.slice(4, 6));
  if (hours > 23 || minutes > 59) return reject();
  const offset = (hours * 60 + minutes) * (zone[0] === '-' ? -1 : 1);
  return BigInt(milliseconds - offset * 60000) * 1000n + BigInt((m[3] || '').padEnd(6, '0'));
}
export interface OriginalRosterBinding {
  readonly intent: Readonly<OriginalIntentIdentity>;
  readonly request: Readonly<{
    schema_version: 2;
    profile: MTTPreReserveSnapshot['profile'];
    eligibility_settings: MTTPreReserveSnapshot['eligibility_settings'];
    complete_roster: MTTPreReserveSnapshot['complete_roster'];
  }>;
}
export function assertOriginalRosterIdentity(
  binding: OriginalRosterBinding,
  current: OriginalIntentIdentity
): void {
  for (const k of keys) if (binding.intent[k] !== current[k]) reject();
}
export function retainOriginalRoster(
  snapshot: MTTPreReserveSnapshot,
  current: OriginalIntentIdentity
): OriginalRosterBinding {
  if (
    snapshot.kind !== 'proposal_only' ||
    snapshot.schema_version !== 2 ||
    snapshot.profile !== profile ||
    !Array.isArray(snapshot.complete_roster) ||
    snapshot.complete_roster.length < 2 ||
    snapshot.complete_roster.length > 10
  )
    reject();
  assertEligibility(snapshot.eligibility_settings);
  if (snapshot.complete_roster.length > snapshot.eligibility_settings.max_players) reject();
  const binding: OriginalRosterBinding = Object.freeze({
    intent: Object.freeze({ ...snapshot.intent }),
    request: Object.freeze({
      schema_version: 2 as const,
      profile: snapshot.profile,
      eligibility_settings: Object.freeze({ ...snapshot.eligibility_settings }),
      complete_roster: Object.freeze(
        snapshot.complete_roster.map((row) => Object.freeze({ ...row }))
      ),
    }),
  });
  assertOriginalRosterIdentity(binding, current);
  return binding;
}
export type EntrySourceRef =
  | Readonly<{
      rail: 'purchase';
      key_domain: 'tournament_registration_v1' | 'tournament_chip_purchase';
      idempotency_key: string;
    }>
  | Readonly<{
      rail: 'ticket';
      entitlement_id: string;
      ticket_id: string;
      source_ledger_id: string;
      registration_id: string;
    }>
  | Readonly<{
      rail: 'horse_wallet';
      entitlement_id: string;
      source_ledger_id: string;
      registration_id: string;
    }>
  | Readonly<{ rail: 'configured_zero_cost_horse'; registration_id: string }>
  | Readonly<{
      rail: 'direct_satellite_seat';
      entitlement_id: string;
      source_satellite_id: string;
      award_place: number;
      source_ledger_id: string;
      registration_id: string;
    }>
  | Readonly<{
      rail: 'registration_wallet';
      registration_id: string;
      entitlement_id: string;
      source_ledger_id: string;
      diamond_ledger_id: null;
      diamond_custody_id: null;
    }>
  | Readonly<{
      rail: 'registration_diamonds';
      registration_id: string;
      entitlement_id: null;
      source_ledger_id: null;
      diamond_ledger_id: string;
      diamond_custody_id: string;
    }>
  | Readonly<{
      rail: 'registration_zero_cost';
      registration_id: string;
      entitlement_id: null;
      source_ledger_id: null;
      diamond_ledger_id: null;
      diamond_custody_id: null;
    }>;
export interface DecodedOriginalRoster {
  readonly association: MTTOriginalRosterAssociation;
  readonly entryEnrollments: readonly Readonly<{
    participant_id: string;
    source_ref: EntrySourceRef;
  }>[];
}
function sourceReference(value: unknown, participant: string): EntrySourceRef {
  const r = object(value);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const uuidField = (name: string): string => {
    if (typeof r[name] !== 'string' || !uuid.test(r[name] as string)) return reject();
    return r[name] as string;
  };
  let result: EntrySourceRef;
  if (r.rail === 'purchase') {
    if (
      (r.key_domain !== 'tournament_registration_v1' &&
        r.key_domain !== 'tournament_chip_purchase') ||
      typeof r.idempotency_key !== 'string' ||
      !r.idempotency_key
    )
      return reject();
    result = { rail: r.rail, key_domain: r.key_domain, idempotency_key: r.idempotency_key };
  } else {
    const registration_id = uuidField('registration_id');
    if (registration_id.toLowerCase() !== participant.toLowerCase()) return reject();
    if (r.rail === 'registration_wallet') {
      if (r.diamond_ledger_id !== null || r.diamond_custody_id !== null) return reject();
      result = {
        rail: r.rail,
        registration_id,
        entitlement_id: uuidField('entitlement_id'),
        source_ledger_id: uuidField('source_ledger_id'),
        diamond_ledger_id: null,
        diamond_custody_id: null,
      };
    } else if (r.rail === 'registration_diamonds') {
      if (
        r.entitlement_id !== null ||
        r.source_ledger_id !== null ||
        typeof r.diamond_ledger_id !== 'string' ||
        !/^(?:0|-?[1-9][0-9]{0,18})$/.test(r.diamond_ledger_id)
      )
        return reject();
      const ledger = BigInt(r.diamond_ledger_id);
      if (ledger < -9223372036854775808n || ledger > 9223372036854775807n) return reject();
      result = {
        rail: r.rail,
        registration_id,
        entitlement_id: null,
        source_ledger_id: null,
        diamond_ledger_id: r.diamond_ledger_id,
        diamond_custody_id: uuidField('diamond_custody_id'),
      };
    } else if (r.rail === 'registration_zero_cost') {
      if (
        r.entitlement_id !== null ||
        r.source_ledger_id !== null ||
        r.diamond_ledger_id !== null ||
        r.diamond_custody_id !== null
      )
        return reject();
      result = {
        rail: r.rail,
        registration_id,
        entitlement_id: null,
        source_ledger_id: null,
        diamond_ledger_id: null,
        diamond_custody_id: null,
      };
    } else if (r.rail === 'direct_satellite_seat') {
      if (!Number.isSafeInteger(r.award_place) || (r.award_place as number) < 1) return reject();
      result = {
        rail: r.rail,
        entitlement_id: uuidField('entitlement_id'),
        source_satellite_id: uuidField('source_satellite_id'),
        award_place: r.award_place as number,
        source_ledger_id: uuidField('source_ledger_id'),
        registration_id,
      };
    } else if (r.rail === 'ticket')
      result = {
        rail: r.rail,
        entitlement_id: uuidField('entitlement_id'),
        ticket_id: uuidField('ticket_id'),
        source_ledger_id: uuidField('source_ledger_id'),
        registration_id,
      };
    else if (r.rail === 'horse_wallet')
      result = {
        rail: r.rail,
        entitlement_id: uuidField('entitlement_id'),
        source_ledger_id: uuidField('source_ledger_id'),
        registration_id,
      };
    else if (r.rail === 'configured_zero_cost_horse') result = { rail: r.rail, registration_id };
    else return reject();
  }
  if (Object.keys(r).length !== Object.keys(result).length) return reject();
  return Object.freeze(result);
}
/** Only call on the current original Session's canonical reply. No standalone receipt authority. */
export function decodeOriginalRoster(
  binding: OriginalRosterBinding,
  value: unknown,
  current: OriginalIntentIdentity
): DecodedOriginalRoster {
  assertOriginalRosterIdentity(binding, current);
  const outer = object(value),
    saved = object(outer.original_roster);
  const i = binding.intent;
  assertEligibility(saved.eligibility_settings);
  const savedSettings = object(saved.eligibility_settings);
  for (const key of settingsKeys)
    if (savedSettings[key] !== binding.request.eligibility_settings[key]) reject();

  const echoed = object(saved.intent);
  if (Object.keys(echoed).length !== keys.length) reject();
  for (const key of keys) if (echoed[key] !== i[key]) reject();
  const savedIntent = Object.freeze(
    Object.fromEntries(keys.map((key) => [key, echoed[key]]))
  ) as Readonly<OriginalIntentIdentity>;

  if (
    outer.ok !== true ||
    outer.state !== 'reserved' ||
    outer.tournament_id !== i.tournament_id ||
    outer.table_id !== i.table_id ||
    outer.permit_id !== i.permit_id ||
    outer.generation !== i.lease_generation ||
    outer.custody_id !== i.custody_id ||
    outer.lifecycle !== i.lifecycle ||
    outer.hand_number !== i.hand_number
  )
    reject();
  if (
    saved.kind !== 'saved_original_roster' ||
    saved.schema_version !== 2 ||
    saved.profile !== profile ||
    saved.permit_state !== 'reserved' ||
    saved.evidence_id !== null ||
    saved.permit_id !== i.permit_id ||
    saved.tournament_id !== i.tournament_id ||
    saved.table_id !== i.table_id ||
    saved.table_lifecycle !== i.lifecycle ||
    saved.hand_number !== i.hand_number
  )
    reject();
  // If a successor echoes additional identity fields, contradictions must refuse.
  for (const k of keys) if (k in saved && saved[k] !== i[k]) reject();
  if (
    !Array.isArray(saved.complete_roster) ||
    saved.complete_roster.length !== binding.request.complete_roster.length
  )
    reject();
  const uuidKeys = ['user_id', 'participant_id', 'table_id', 'seat_id', 'occupancy_id'] as const;
  const seen = new Map<string, Set<string>>(uuidKeys.map((k) => [k, new Set()]));
  const chairs = new Set<number>();
  for (let n = 0; n < binding.request.complete_roster.length; n++) {
    const expected = binding.request.complete_roster[n],
      actual = object((saved.complete_roster as unknown[])[n]);
    for (const k of uuidKeys) {
      if (
        typeof actual[k] !== 'string' ||
        (actual[k] as string).toLowerCase() !== expected[k].toLowerCase()
      )
        reject();
      if (k !== 'table_id' && seen.get(k)!.has(expected[k].toLowerCase())) reject();
      seen.get(k)!.add(expected[k].toLowerCase());
    }
    if (
      expected.table_id !== i.table_id ||
      !Number.isSafeInteger(expected.seat_number) ||
      expected.seat_number < 1 ||
      expected.seat_number > 10 ||
      chairs.has(expected.seat_number) ||
      (n > 0 && expected.seat_number <= binding.request.complete_roster[n - 1].seat_number)
    )
      reject();
    chairs.add(expected.seat_number);
    if (
      decimal(actual.seat_number) !== decimal(expected.seat_number) ||
      decimal(actual.participant_rebuys) !== decimal(expected.participant_rebuys) ||
      decimal(actual.stack) !== decimal(expected.stack) ||
      !(expected.stack > 0) ||
      !Number.isSafeInteger(expected.participant_rebuys) ||
      expected.participant_rebuys < 0
    )
      reject();
    for (const k of ['participant_registered_at', 'joined_at'] as const)
      if (instant(actual[k]) !== instant(expected[k])) reject();
  }
  if (!Array.isArray(saved.entry_enrollments) || saved.entry_enrollments.length > 10) reject();
  const enrollmentKeys = new Set<string>();
  const participants = new Set<string>();
  const enrollments = (saved.entry_enrollments as unknown[]).map((value) => {
    const e = object(value);
    if (
      typeof e.participant_id !== 'string' ||
      !seen.get('participant_id')!.has(e.participant_id.toLowerCase()) ||
      participants.has(e.participant_id.toLowerCase())
    )
      reject();
    const participant = e.participant_id as string;
    const source_ref = sourceReference(e.source_ref, participant);
    const key = JSON.stringify(source_ref);
    if (enrollmentKeys.has(key)) reject();
    enrollmentKeys.add(key);
    participants.add(participant.toLowerCase());
    return Object.freeze({ participant_id: participant, source_ref });
  });
  return Object.freeze({
    association: Object.freeze({
      intent: savedIntent,
      schema_version: 2 as const,
      profile: binding.request.profile,
      eligibility_settings: Object.freeze({ ...binding.request.eligibility_settings }),
      complete_roster: binding.request.complete_roster,
    }),
    entryEnrollments: Object.freeze(enrollments),
  });
}
