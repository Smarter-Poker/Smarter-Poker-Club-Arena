import { test, expect } from 'vitest';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import { F06EngineWriterCapture } from './F06EngineWriterCapture.js';
import type { F06Rpc } from './F06HandPermit.js';

const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
function fixture() {
  const identity = {
    admission_id: id(1),
    tournament_id: id(2),
    table_id: id(3),
    lifecycle: '1',
    lease_generation: id(4),
    custody_id: id(5),
  };
  let allocation: F06Rpc | undefined;
  const calls: string[] = [];
  const session = new F06OriginalIntentSession(
    identity,
    async (name, args) => {
      calls.push(name);
      if (name === 'fn_f06_resolve_engine_admission')
        return {
          data: {
            ...identity,
            ok: true,
            state: 'ELIGIBLE',
            revision: '1',
            protocol_epoch: '1',
            enrollment_token: 'a'.repeat(64),
          },
          error: null,
        };
      if (name === 'fn_f06_register_engine_admission')
        return {
          data: { ...identity, ok: true, state: 'ACTIVE', revision: '1' },
          error: null,
        };
      if (name === 'fn_f06_allocate_original_intent')
        return allocation
          ? allocation(name, args)
          : {
              data: {
                ...identity,
                ok: true,
                state: 'INTENT',
                permit_id: args.p_permit_id,
                hand_number: '1000001',
                admission_revision: '1',
              },
              error: null,
            };
      throw Error(name);
    },
    () => true,
    () => id(10)
  );
  return {
    session,
    calls,
    setAllocation: (value: F06Rpc) => {
      allocation = value;
    },
  };
}

test('outside engine context cannot create a Session engine-origin capsule', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  f.session.fenceForRetirement();
  const observation = await f.session.inspectOriginalWriters();
  expect(observation.writers).toHaveLength(2);
  expect(observation.writers.every((w) => w.engineWriterOrigin === null)).toBe(true);
});

test('unknown allocator retains the exact authenticated engine origin across snapshots', async () => {
  const f = fixture();
  await f.session.admit();
  const engine = new F06EngineWriterCapture();
  f.setAllocation(async () => ({ data: null, error: 'lost' }));
  await expect(engine.run('allocator', () => f.session.allocate())).rejects.toThrow();
  f.session.fenceForRetirement();
  engine.fence();
  const physical = await engine.join(() => undefined);
  const first = await f.session.inspectOriginalWriters();
  const second = await f.session.inspectOriginalWriters();
  const writer = first.writers.find((w) => w.kind === 'allocator')!;
  expect(writer.state).toBe('unknown');
  expect(physical.writers).toHaveLength(1);
  expect(engine.ownsAcceptedOrigin(writer.engineWriterOrigin, physical.writers[0].id)).toBe(true);
  expect(second.writers[1].engineWriterOrigin).toBe(writer.engineWriterOrigin);
  expect(Object.isFrozen(writer.engineWriterOrigin)).toBe(true);
  expect(engine.ownsAcceptedOrigin({ ...writer.engineWriterOrigin }, physical.writers[0].id)).toBe(
    false
  );
  expect(
    new F06EngineWriterCapture().ownsAcceptedOrigin(
      writer.engineWriterOrigin,
      physical.writers[0].id
    )
  ).toBe(false);
  expect(f.calls.filter((name) => name === 'fn_f06_allocate_original_intent')).toHaveLength(1);
});

test('accepted allocator keeps its launch origin through fencing and physical settlement', async () => {
  const f = fixture();
  await f.session.admit();
  let release!: (value: Awaited<ReturnType<F06Rpc>>) => void;
  let launched!: () => void;
  const started = new Promise<void>((resolve) => {
    launched = resolve;
  });
  f.setAllocation(() => {
    launched();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const engine = new F06EngineWriterCapture();
  const pending = engine.run('allocator', () => f.session.allocate());
  const rejected = expect(pending).rejects.toThrow();
  await started;
  f.session.fenceForRetirement();
  engine.fence();
  let joined = false;
  const observation = f.session.inspectOriginalWriters().then((value) => {
    joined = true;
    return value;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  release({ data: null, error: 'lost after fence' });
  await rejected;
  const result = await observation;
  const physical = await engine.join(() => undefined);
  expect(
    engine.ownsAcceptedOrigin(result.writers[1].engineWriterOrigin, physical.writers[0].id)
  ).toBe(true);
  expect(result.writers[1].state).toBe('unknown');
  await expect(f.session.allocate()).rejects.toThrow('f06_admission_not_active');
  expect(f.calls.filter((name) => name === 'fn_f06_allocate_original_intent')).toHaveLength(1);
});
