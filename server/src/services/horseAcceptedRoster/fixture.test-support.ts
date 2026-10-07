/** SYNTHETIC test support (P14.2). Builds the settlement door's private
 * `accepted_roster` success field and copies it through the engine's actual
 * acceptance reader, so worker/journal tests carry exactly what handHistory.ts
 * would attach. No database produced these values. */
import { ACCEPTED_ROSTER_PRODUCER_VERSION, readAcceptedRosterReturn } from './acceptance.js';
import type { AcceptedRoster, ReturnedRosterTransport } from './contract.js';

export function doorRosterCapsule(
  tableId: string,
  handNumber: number,
  handId: string,
  change: (roster: AcceptedRoster) => void = () => {}
): AcceptedRoster {
  const roster: AcceptedRoster = {
    version: 1,
    basis: 'profiles_read_in_acceptance_transaction',
    tableId,
    handId,
    handNumber,
    capturedAt: '2026-10-06T22:00:00.123456Z',
    actors: [
      {
        userId: '20000000-0000-4000-8000-000000000001',
        seat: 1,
        seatId: '40000000-0000-4000-8000-000000000001',
        seatJoinedAt: '2026-10-06T21:00:00.654321+00:00',
        classification: 'horse',
        status: 'canonical_boolean',
      },
      {
        userId: '20000000-0000-4000-8000-000000000002',
        seat: 2,
        seatId: '40000000-0000-4000-8000-000000000002',
        seatJoinedAt: '2026-10-06T21:30:00+00:00',
        classification: 'human',
        status: 'canonical_boolean',
      },
    ],
  };
  change(roster);
  return roster;
}

export function doorRosterTransport(
  tableId: string,
  handNumber: number,
  handId: string,
  change?: (roster: AcceptedRoster) => void
): ReturnedRosterTransport {
  const payloadDigest = 'e'.repeat(64);
  const read = readAcceptedRosterReturn(
    {
      version: 1,
      status: 'captured',
      reasons: [],
      payloadDigest,
      producerVersion: ACCEPTED_ROSTER_PRODUCER_VERSION,
      roster: doorRosterCapsule(tableId, handNumber, handId, change),
    },
    { tableId, handNumber, historyId: handId, payloadDigest }
  );
  if (read.status !== 'captured') throw Error(`synthetic door roster refused: ${read.status}`);
  return structuredClone(read.transport);
}
