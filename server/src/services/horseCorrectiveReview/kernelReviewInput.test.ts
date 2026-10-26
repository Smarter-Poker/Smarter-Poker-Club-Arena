import { describe, it, expect } from 'vitest';
import { rebuildCorrectiveSourceCustody } from './kernelReviewInput.js';
import { correctiveFixture, HAND, HAND_KEY, TABLE } from './fixture.test-support.js';
import { journalHash } from '../horseDecisionJournal/record.js';
import {
  readAcceptedRosterReturn,
  ACCEPTED_ROSTER_PRODUCER_VERSION,
} from '../horseAcceptedRoster/acceptance.js';
import type { AcceptedRoster } from '../horseAcceptedRoster/contract.js';
import { createUnsignedAcceptedCommitmentExport } from '../horseAcceptedRoster/exporter.js';
import { evidenceDigest } from './authority.js';

/** Synthetic raw rows exercise reconstruction only; no database or signer ran. */
function sourceFixture() {
  const f = correctiveFixture(),
    players = f.snapshot.gameState.players;
  const payloadText = JSON.stringify(JSON.parse(f.commitments.payloadText), null, 1);
  const payloadDigest = journalHash(payloadText);
  const roster: AcceptedRoster = {
    version: 1,
    basis: 'profiles_read_in_acceptance_transaction',
    tableId: TABLE,
    handId: HAND,
    handNumber: 12,
    capturedAt: '2026-09-14T14:00:00.000000Z',
    actors: players
      .map((p, i) => ({
        userId: p.user_id,
        seat: p.seat,
        seatId: `70000000-0000-4000-8000-00000000000${i + 1}`,
        seatJoinedAt: '2026-09-14T13:00:00.123456+00:00',
        classification: i === 0 ? ('horse' as const) : ('human' as const),
        status: 'canonical_boolean' as const,
      }))
      .sort((a, b) => a.userId.localeCompare(b.userId)),
  };
  const returned = readAcceptedRosterReturn(
    {
      version: 1,
      status: 'captured',
      reasons: [],
      payloadDigest,
      producerVersion: ACCEPTED_ROSTER_PRODUCER_VERSION,
      roster,
    },
    { tableId: TABLE, handNumber: 12, historyId: HAND, payloadDigest }
  );
  if (returned.status !== 'captured') throw Error('synthetic accepted roster');
  const hand = { ...f.hand, acceptedActorRoster: returned.transport };
  const accepted = f.make('accepted_hand', 3, hand);
  const row = {
    hand_id: HAND,
    table_id: TABLE,
    hand_number: '12',
    atomic_hand_id: HAND,
    atomic_table_id: TABLE,
    atomic_hand_number: '12',
    big_blind: '1.00',
    game_variant: 'nlh',
    tournament_id: null,
    actions_text: JSON.stringify(hand.actions),
    players_text: JSON.stringify(
      players.map((p) => ({
        userId: p.user_id,
        seat: p.seat,
        username: 'SYNTHETIC_PRIVATE_NAME',
        cards: ['As', 'Kd'],
      }))
    ),
    payload_text: payloadText,
    payload_digest: payloadDigest,
    core_payload_digest: 'c'.repeat(64),
    post_commit_request_digest: 'd'.repeat(64),
    stack_result_text: JSON.stringify({
      success: true,
      hand_id: '90000000-0000-4000-8000-000000000009',
      table_id: TABLE,
      hand_number: 12,
      tournament_id: null,
      players: 2,
      mode: 'delta',
      departed: [],
      rebased: {},
      written: Object.fromEntries(players.map((p) => [p.user_id, 100])),
      request: {
        stacks: players.map((p, i) => ({
          user_id: p.user_id,
          stack: 100,
          stack_before: 100,
          seat_id: `70000000-0000-4000-8000-00000000000${i + 1}`,
          seat_joined_at: '2026-09-14T13:00:00.123456+00:00',
        })),
        rake: 0,
        bbj: 0,
        inflow: 0,
      },
    }),
    roster_hand_id: HAND,
    roster_status: 'captured',
    roster_payload_digest: payloadDigest,
    roster_producer_version: ACCEPTED_ROSTER_PRODUCER_VERSION,
    roster_text: JSON.stringify(roster),
    committed_at: '2026-09-14T14:00:00.000Z',
    post_commit_completed_at: null,
    read_at: '2026-09-14T14:00:01.000Z',
    snapshot_id: '20:30:22,24',
  };
  return {
    records: [accepted],
    handKey: HAND_KEY,
    acceptedHandRecordDigest: accepted.sha256,
    rows: [row],
  };
}
const rebuild = (input: ReturnType<typeof sourceFixture>) =>
  rebuildCorrectiveSourceCustody(
    input.records,
    input.handKey,
    input.acceptedHandRecordDigest,
    input.rows
  );

describe('unsigned independent-review source custody preflight', () => {
  it('rebuilds the existing exact-text exporter without claiming source trust or qualification', () => {
    const input = sourceFixture(),
      expected = createUnsignedAcceptedCommitmentExport(input);
    expect(expected.sourceExport.status, JSON.stringify(expected.sourceExport.reasons)).toBe(
      'unsigned_export'
    );
    expect(rebuild(input)).toEqual({
      version: 1,
      status: 'reconstructed_unsigned',
      custodyDigest: evidenceDigest(expected),
      sourceReadVerified: false,
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    });
  });
  it.each(['payload', 'source', 'record', 'actions', 'roster', 'missing', 'duplicate'] as const)(
    'refuses corrupt %s instead of hashing an unavailable export',
    (fault) => {
      const input = sourceFixture();
      if (fault === 'payload') input.rows[0].payload_text += ' ';
      if (fault === 'source') input.rows[0].atomic_hand_id = '90000000-0000-4000-8000-000000000009';
      if (fault === 'record') input.acceptedHandRecordDigest = '0'.repeat(64);
      if (fault === 'actions') input.rows[0].actions_text = '[]';
      if (fault === 'roster') input.rows[0].roster_payload_digest = '0'.repeat(64);
      if (fault === 'missing') input.rows = [];
      if (fault === 'duplicate') input.rows.push(structuredClone(input.rows[0]));
      expect(rebuild(input)).toMatchObject({
        status: 'unavailable',
        custodyDigest: null,
        sourceReadVerified: false,
        qualified: false,
        completePopulation: false,
        activationAllowed: false,
      });
    }
  );
  it('returns only a digest and bounded status, never hidden source/card/actor fields', () => {
    const input = sourceFixture(),
      output = JSON.stringify(rebuild(input));
    for (const privateText of [
      'SYNTHETIC_PRIVATE_NAME',
      input.rows[0].payload_text,
      input.rows[0].roster_text,
      input.rows[0].hand_id,
      input.rows[0].table_id,
      'As',
      'Kd',
    ])
      expect(output).not.toContain(privateText);
    expect(rebuild(input).status).toBe('reconstructed_unsigned');
  });
  it('refuses invalid or oversized record populations before reconstruction', () => {
    const input = sourceFixture();
    expect(
      rebuildCorrectiveSourceCustody([], input.handKey, input.acceptedHandRecordDigest, input.rows)
        .status
    ).toBe('unavailable');
    expect(
      rebuildCorrectiveSourceCustody(
        Array(257).fill(input.records[0]),
        input.handKey,
        input.acceptedHandRecordDigest,
        input.rows
      ).status
    ).toBe('unavailable');
  });
  it('binds the exact reconstructed source read metadata, not only a hand label', () => {
    const first = sourceFixture(),
      second = sourceFixture();
    second.rows[0].snapshot_id = '21:31:23,25';
    const a = rebuild(first),
      b = rebuild(second);
    expect(a.status).toBe('reconstructed_unsigned');
    expect(b.status).toBe('reconstructed_unsigned');
    expect(a.custodyDigest).not.toBe(b.custodyDigest);
    expect(Object.isFrozen(a)).toBe(true);
  });
  it('does not accept an asserted qualified export instead of raw accepted rows', () => {
    const input = sourceFixture();
    const claimed = {
      status: 'unsigned_export',
      qualified: true,
      sourceReadVerified: true,
      custodyDigest: 'a'.repeat(64),
    };
    expect(
      rebuildCorrectiveSourceCustody(input.records, input.handKey, input.acceptedHandRecordDigest, [
        claimed,
      ])
    ).toMatchObject({
      status: 'unavailable',
      custodyDigest: null,
      qualified: false,
      sourceReadVerified: false,
    });
  });
});
