import { describe, expect, it } from 'vitest';
import {
  MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH,
  chunkTournamentManagerWakeReceipts,
  reconcileTournamentManagerWakeAcknowledgement,
  type TournamentManagerWakeReceipt,
} from './TournamentManagerWakeProtocol.js';

describe('tournament manager wake protocol', () => {
  it('bounds every acknowledgement statement without dropping a receipt', () => {
    const receipts: TournamentManagerWakeReceipt[] = Array.from(
      { length: MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH * 2 + 1 },
      (_, index) => ({ id: index + 1, generation: 1 })
    );

    const chunks = chunkTournamentManagerWakeReceipts(receipts);

    expect(chunks.map((chunk) => chunk.length)).toEqual([
      MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH,
      MAX_TOURNAMENT_MANAGER_WAKE_ACK_BATCH,
      1,
    ]);
    expect(chunks.flat()).toEqual(receipts);
  });

  it('finishes a receipt only when the exact captured generation was consumed', () => {
    const pending = reconcileTournamentManagerWakeAcknowledgement(
      [
        { id: 11, generation: 4 },
        { id: 12, generation: 9 },
      ],
      [
        { id: 11, generation: 4, consumed: true },
        { id: 12, generation: 10, consumed: false },
      ]
    );

    expect(pending).toEqual(new Map([[12, 10]]));
  });

  it('rejects an acknowledgement that omits, invents, or regresses a generation', () => {
    expect(
      reconcileTournamentManagerWakeAcknowledgement(
        [{ id: 21, generation: 3 }],
        [{ id: 21, generation: 2, consumed: true }]
      )
    ).toBeNull();
    expect(
      reconcileTournamentManagerWakeAcknowledgement([{ id: 21, generation: 3 }], [])
    ).toBeNull();
    expect(
      reconcileTournamentManagerWakeAcknowledgement(
        [{ id: 21, generation: 3 }],
        [
          { id: 21, generation: 3, consumed: true },
          { id: 99, generation: 1, consumed: false },
        ]
      )
    ).toBeNull();
  });
});
