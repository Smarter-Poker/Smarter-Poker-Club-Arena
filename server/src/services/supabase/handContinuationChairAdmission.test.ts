import { expect, it, vi } from 'vitest';
vi.mock('./client.js', () => ({ supabase: {}, maintenanceSupabase: {} }));
import {
  claimHandContinuation,
  claimedContinuationChair,
  refreshClaimedContinuationChairs,
} from './handContinuation.js';
import { encodePrivateHandContinuation } from '../../engine/PrivateHandContinuation.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const original = {
    tournament_id: id(1),
    table_id: id(2),
    lease_generation: id(3),
    permit_id: id(4),
    lifecycle: '7',
    hand_number: '42',
    custody_id: id(5),
  };
  const seats = [6, 7].map((n) => ({
    user_id: id(n),
    seat_id: id(n + 10),
    seat_joined_at: '2026-10-28T00:00:00.123456Z',
    stack_before: 1000,
  }));
  const capsule = {
    version: 1 as const,
    original,
    seats,
    batch: {
      version: 1 as const,
      sequence: 0,
      controller: 'private-test-controller',
      events: [],
      engine: { fields: {} },
    },
  };
  const encoded = encodePrivateHandContinuation(capsule);
  const writer = id(8);
  const data: any = {
    ok: true,
    table_id: id(2),
    writer_generation: writer,
    continuation: {
      payload: encoded.payload,
      sha256: encoded.sha256,
      hand_number: '42',
      sequence: '0',
    },
    chair_admission: {
      version: 1,
      tournament_id: id(1),
      table_id: id(2),
      writer_generation: writer,
      original_generation: id(3),
      hand_number: '42',
      sequence: '0',
      payload_sha256: encoded.sha256,
      seats: seats.map((seat, n) => ({ ...seat, authorized_stack: n ? 1000 : 11000 })),
    },
  };
  const transport = vi.fn(async () => ({ data, error: null }));
  const claim = () => claimHandContinuation(id(1), writer, id(2), () => true, transport);
  return { capsule, data, encoded, claim, transport };
}
it('binds canonical funded chairs to only the exact decoded claim without changing its bytes', async () => {
  const { claim, encoded, transport } = fixture();
  const value = (await claim())!;
  expect(encodePrivateHandContinuation(value)).toEqual(encoded);
  const chair = claimedContinuationChair(value, id(6));
  expect(chair).toMatchObject({ stack_before: 1000, authorized_stack: 11000 });
  expect(Object.isFrozen(chair)).toBe(true);
  expect(claimedContinuationChair(structuredClone(value), id(6))).toBeNull();
  expect(claimedContinuationChair(value, id(99))).toBeNull();
  expect(JSON.stringify(value)).not.toContain('authorized_stack');
  expect(transport).toHaveBeenCalledOnce();
});
const failures: [string, (a: any) => void][] = [
  ['version', (a) => (a.version = 2)],
  ['tournament', (a) => (a.tournament_id = id(9))],
  ['table', (a) => (a.table_id = id(9))],
  ['writer', (a) => (a.writer_generation = id(9))],
  ['original generation', (a) => (a.original_generation = id(9))],
  ['hand', (a) => (a.hand_number = '43')],
  ['sequence', (a) => (a.sequence = '1')],
  ['digest', (a) => (a.payload_sha256 = '0'.repeat(64))],
  ['missing chair', (a) => a.seats.pop()],
  ['extra chair', (a) => a.seats.push(a.seats[0])],
  ['duplicate user', (a) => (a.seats[1] = { ...a.seats[0] })],
  ['unknown user', (a) => (a.seats[0].user_id = id(99))],
  ['changed physical seat', (a) => (a.seats[0].seat_id = id(99))],
  [
    'different microsecond epoch',
    (a) => (a.seats[0].seat_joined_at = '2026-10-28T00:00:00.123457Z'),
  ],
  ['changed baseline', (a) => (a.seats[0].stack_before = 999)],
  ['non-numeric stack', (a) => (a.seats[0].authorized_stack = '11000')],
  ['non-finite stack', (a) => (a.seats[0].authorized_stack = Infinity)],
  ['NaN stack', (a) => (a.seats[0].authorized_stack = NaN)],
  ['stack below baseline', (a) => (a.seats[0].authorized_stack = 999)],
  ['unsafe stack', (a) => (a.seats[0].authorized_stack = Number.MAX_SAFE_INTEGER + 1)],
];
it.each(failures)('refuses %s evidence without a retry', async (_name, fault) => {
  const { data, claim, transport } = fixture();
  fault(data.chair_admission);
  await expect(claim()).rejects.toThrow('Chair Admission Is Unproven');
  expect(transport).toHaveBeenCalledOnce();
});
it.each([null, [], 'not-a-proof'])(
  'does not coerce malformed present proof into legacy absence: %s',
  async (proof) => {
    const { data, claim } = fixture();
    data.chair_admission = proof;
    await expect(claim()).rejects.toThrow('Chair Admission Is Unproven');
  }
);
it('keeps an older unchanged-stack response compatible without authorizing funded changes', async () => {
  const { data, claim, encoded } = fixture();
  delete data.chair_admission;
  const value = (await claim())!;
  expect(encodePrivateHandContinuation(value)).toEqual(encoded);
  expect(claimedContinuationChair(value, id(6))).toBeNull();
});
it('does not accept a projection when the claim owner changes before acknowledgment', async () => {
  const { data } = fixture();
  let current = true;
  await expect(
    claimHandContinuation(
      id(1),
      id(8),
      id(2),
      () => current,
      async () => {
        current = false;
        return { data, error: null };
      }
    )
  ).rejects.toThrow('Claim Is Unproven');
});

it('refreshes only the same claimed object with fresh canonical chairs and byte-identical payload', async () => {
  const { claim, data, encoded } = fixture();
  const original = (await claim())!;
  const previous = claimedContinuationChair(original, id(6))!;
  const other = claimedContinuationChair(original, id(7))!;
  data.chair_admission.seats[0].authorized_stack = 21000;
  const refresh = vi.fn(async () => ({ data, error: null }));

  await refreshClaimedContinuationChairs(original, () => true, refresh);

  expect(claimedContinuationChair(original, id(6))).toMatchObject({
    stack_before: 1000,
    authorized_stack: 21000,
  });
  expect(claimedContinuationChair(original, id(6))).not.toBe(previous);
  expect(Object.isFrozen(claimedContinuationChair(original, id(6)))).toBe(true);
  expect(previous.authorized_stack).toBe(11000);
  expect(claimedContinuationChair(original, id(7))).toEqual(other);
  expect(claimedContinuationChair(structuredClone(original), id(6))).toBeNull();
  expect(encodePrivateHandContinuation(original)).toEqual(encoded);
  expect(JSON.stringify(original)).not.toContain('authorized_stack');
  expect(refresh).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledWith('fn_f06_claim_hand_continuation', {
    p_tournament_id: id(1),
    p_lease_generation: id(8),
    p_table_id: id(2),
  });
});

it('an overlapping refresh cannot replace the newer capability installed by the first acknowledgment', async () => {
  const { claim, data, encoded } = fixture();
  const original = (await claim())!;
  const newer = structuredClone(data);
  newer.chair_admission.seats[0].authorized_stack = 31000;
  const older = structuredClone(data);
  older.chair_admission.seats[0].authorized_stack = 21000;
  let acknowledgeNewer!: (value: { data: typeof data; error: null }) => void;
  let acknowledgeOlder!: (value: { data: typeof data; error: null }) => void;
  const firstTransport = vi.fn(
    () => new Promise<{ data: typeof data; error: null }>((resolve) => (acknowledgeNewer = resolve))
  );
  const secondTransport = vi.fn(
    () => new Promise<{ data: typeof data; error: null }>((resolve) => (acknowledgeOlder = resolve))
  );
  const first = refreshClaimedContinuationChairs(original, () => true, firstTransport);
  const second = refreshClaimedContinuationChairs(original, () => true, secondTransport);
  const refused = expect(second).rejects.toThrow('Chair Admission Is Unproven');

  acknowledgeNewer({ data: newer, error: null });
  await first;
  const winner = claimedContinuationChair(original, id(6));
  expect(winner?.authorized_stack).toBe(31000);
  acknowledgeOlder({ data: older, error: null });
  await refused;

  expect(claimedContinuationChair(original, id(6))).toBe(winner);
  expect(encodePrivateHandContinuation(original)).toEqual(encoded);
  for (const transport of [firstTransport, secondTransport]) {
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith('fn_f06_claim_hand_continuation', {
      p_tournament_id: id(1),
      p_lease_generation: id(8),
      p_table_id: id(2),
    });
  }
});

it.each(['unclaimed copy', 'legacy claim', 'owner already changed'])(
  'refuses refresh before any claim for %s',
  async (kind) => {
    const { data, claim, encoded } = fixture();
    if (kind === 'legacy claim') delete data.chair_admission;
    const claimed = (await claim())!;
    const original = kind === 'unclaimed copy' ? structuredClone(claimed) : claimed;
    const previous = claimedContinuationChair(original, id(6));
    const refresh = vi.fn(async () => ({ data, error: null }));

    await expect(
      refreshClaimedContinuationChairs(original, () => kind !== 'owner already changed', refresh)
    ).rejects.toThrow('Chair Admission Is Unproven');

    expect(refresh).not.toHaveBeenCalled();
    expect(claimedContinuationChair(original, id(6))).toBe(previous);
    expect(encodePrivateHandContinuation(original)).toEqual(encoded);
  }
);

it.each([
  'unfunded chair',
  'RPC error',
  'transport rejection',
  'owner changed during claim',
  'changed writer',
  'changed incoming payload',
  'changed local payload',
  'absent proof',
  'absent continuation',
])('refuses %s refresh without replacing the previous capability or retrying', async (kind) => {
  const { data, claim, capsule, encoded } = fixture();
  const original = (await claim())!;
  const previous = original.seats.map((seat) => claimedContinuationChair(original, seat.user_id));
  let current = true;
  data.chair_admission.seats[0].authorized_stack = 21000;
  if (kind === 'unfunded chair') data.chair_admission.seats[0].authorized_stack = 999;
  if (kind === 'changed writer') data.writer_generation = id(99);
  if (kind === 'absent proof') delete data.chair_admission;
  if (kind === 'absent continuation') data.continuation = null;
  if (kind === 'changed incoming payload') {
    capsule.batch.controller = 'different-private-controller';
    const changed = encodePrivateHandContinuation(capsule);
    Object.assign(data.continuation, changed);
    data.chair_admission.payload_sha256 = changed.sha256;
  }
  if (kind === 'changed local payload') original.batch.controller = 'mutated-local-controller';
  const before = encodePrivateHandContinuation(original);
  const refresh = vi.fn(async () => {
    if (kind === 'transport rejection') throw new Error('transport unavailable');
    if (kind === 'owner changed during claim') current = false;
    return { data, error: kind === 'RPC error' ? { message: 'claim refused' } : null };
  });

  await expect(
    refreshClaimedContinuationChairs(original, () => current, refresh)
  ).rejects.toThrow();

  expect(refresh).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledWith('fn_f06_claim_hand_continuation', {
    p_tournament_id: id(1),
    p_lease_generation: id(8),
    p_table_id: id(2),
  });
  original.seats.forEach((seat, index) => {
    expect(claimedContinuationChair(original, seat.user_id)).toBe(previous[index]);
  });
  expect(previous[0]?.authorized_stack).toBe(11000);
  expect(encodePrivateHandContinuation(original)).toEqual(before);
  if (kind !== 'changed local payload') expect(before).toEqual(encoded);
});
