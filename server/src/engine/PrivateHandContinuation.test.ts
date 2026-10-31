import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  continuationEventId,
  decodePrivateHandContinuation,
  encodePrivateHandContinuation,
  type PrivateHandContinuation,
} from './PrivateHandContinuation.js';

function original(): PrivateHandContinuation {
  return {
    version: 1,
    original: {
      tournament_id: 'f1337f21-d409-44b5-a551-60f8f6580cdd',
      lease_generation: '9efee99e-4055-46af-a208-34461a558df6',
      table_id: '46986af0-1071-4223-9a59-055711ba3faf',
      lifecycle: '12',
      permit_id: '0eea0e1a-d9cd-4880-a26a-13c7802a1a2c',
      hand_number: '42',
      custody_id: '9add1ab0-afd7-4945-bd0c-3b0f8ae6bb44',
    },
    seats: [
      { user_id: 'a', seat_id: 's1', seat_joined_at: '2026-10-28T23:00:00Z', stack_before: 100 },
      { user_id: 'b', seat_id: 's2', seat_joined_at: '2026-10-28T23:00:00Z', stack_before: 100 },
    ],
    batch: {
      version: 1,
      sequence: 0,
      controller: 'private-controller',
      events: [],
      engine: {
        stacks: new Map([
          ['a', 100],
          ['b', 100],
        ]),
        pending: new Set(['a']),
        units: 9007199254740993n,
      },
    },
  };
}

describe('private continuation byte identity', () => {
  it('round trips exact units, original seat generations, maps and sets', () => {
    const value = original();
    const encoded = encodePrivateHandContinuation(value);
    expect(decodePrivateHandContinuation(encoded.payload, encoded.sha256)).toEqual(value);
    expect(
      encodePrivateHandContinuation(decodePrivateHandContinuation(encoded.payload, encoded.sha256))
    ).toEqual(encoded);
  });
  it('refuses a changed payload or hash instead of repairing the deck', () => {
    const encoded = encodePrivateHandContinuation(original());
    expect(() => decodePrivateHandContinuation(encoded.payload + ' ', encoded.sha256)).toThrow(
      'Integrity'
    );
    expect(() => decodePrivateHandContinuation(encoded.payload, '0'.repeat(64))).toThrow(
      'Integrity'
    );
  });
  it('refuses duplicate map keys even when the corrupt bytes have a matching hash', () => {
    const v = JSON.parse(encodePrivateHandContinuation(original()).payload);
    v.batch.engine.stacks.continuationMap.push(['a', 999]);
    const payload = JSON.stringify(v);
    expect(() =>
      decodePrivateHandContinuation(payload, createHash('sha256').update(payload).digest('hex'))
    ).toThrow('Duplicate');
  });
  it('refuses overlarge originals before attempting a write', () => {
    const v = original();
    v.batch.controller = 'x'.repeat(1048576);
    expect(() => encodePrivateHandContinuation(v)).toThrow('Too Large');
  });
});

it('preserves existing receipt IDs while separating terminal bank children by player', () => {
  const identity = original().original;
  expect(continuationEventId(identity, 3, 2)).toBe('815edd6d-fbc8-5b1b-a5fb-6ee3460f7bd5');
  expect(continuationEventId(identity, 3, 2, 'hand_complete:time_bank_stop:a')).toBe(
    '3f027966-b972-558b-a945-36fec2e853ce'
  );
  expect(continuationEventId(identity, 3, 2, 'hand_complete:time_bank_stop:b')).not.toBe(
    '3f027966-b972-558b-a945-36fec2e853ce'
  );
});
