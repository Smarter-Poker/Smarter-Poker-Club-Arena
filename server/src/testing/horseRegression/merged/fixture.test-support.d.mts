/** Exact mutable synthetic fixture shape for the retained MJS implementation.
 * This declaration grants no authority and does not widen production contracts. */
import type { correctiveFixture } from '../../../services/horseCorrectiveReview/fixture.test-support.js';
import type { HorseJournalRecord } from '../../../services/horseDecisionJournal/record.js';
import type {
  AcceptedRoster,
  ReturnedRosterTransport,
  RosterSourceAuthority,
} from '../../../services/horseAcceptedRoster/contract.js';

type CorrectiveFixture = ReturnType<typeof correctiveFixture>;
export const HAND_KEY: string;
export const HAND: string;
export const TABLE: string;
export const OTHER: string;
export const CLUB: string;
export interface SyntheticStack {
  user_id: string;
  stack: number;
  stack_before: number;
  seat_id: string;
  seat_joined_at: string;
}
export interface SyntheticRosterRow {
  hand_id: string;
  table_id: string;
  hand_number: string;
  atomic_hand_id: string;
  atomic_table_id: string;
  atomic_hand_number: string;
  big_blind: string;
  game_variant: string;
  tournament_id: string | null;
  actions_text: string;
  players_text: string;
  payload_text: string;
  payload_digest: string;
  core_payload_digest: string;
  post_commit_request_digest: string;
  stack_result_text: string;
  committed_at: string;
  post_commit_completed_at: null;
  read_at: string;
  snapshot_id: string;
}
export interface SyntheticRosterFixture {
  f: CorrectiveFixture;
  roster: AcceptedRoster;
  payload: {
    accepted_hand_facts: {
      contributions: Record<string, number>;
      returned_uncalled: Record<string, number>;
    };
    accepted_actor_roster: AcceptedRoster;
  };
  row: SyntheticRosterRow;
  receipt: {
    success: boolean;
    table_id: string;
    hand_id: string;
    hand_number: number;
    players: number;
    mode: string;
    written: Record<string, number>;
    departed: unknown[];
    rebased: Record<string, unknown>;
    tournament_id: string | null;
    request: { stacks: SyntheticStack[]; rake: number; bbj: number; inflow: number };
  };
  stacks: SyntheticStack[];
  hand: Omit<CorrectiveFixture['hand'], 'actions'> & {
    actions: NonNullable<CorrectiveFixture['hand']['actions']>;
    acceptedActorRoster?: ReturnedRosterTransport;
  };
  input: {
    records: HorseJournalRecord[];
    handKey: string;
    acceptedHandRecordDigest: string;
    rows: SyntheticRosterRow[];
  };
}
export function rosterFixture(
  variant?: Parameters<typeof correctiveFixture>[0],
  format?: Parameters<typeof correctiveFixture>[1],
): SyntheticRosterFixture;
export function sync(fixture: SyntheticRosterFixture): void;
export function syntheticAuthority(
  exported: unknown,
  change?: (authority: RosterSourceAuthority) => void,
): {
  envelope: { authority: RosterSourceAuthority; publicKeyPem: string; signature: string };
  trust: { publicKeyDigest: string; producerSourceDigest: string; allowSynthetic: boolean };
};
