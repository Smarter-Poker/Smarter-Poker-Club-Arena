import { test } from 'vitest';
import assert from 'node:assert/strict';
import { F06OriginalIntentSession } from './F06OriginalIntentSession.js';
import { F06HandPermit } from './F06HandPermit.js';
// Current imported classes; RPC replies are controlled protocol boundaries.
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (v: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const beginInput = (f: ReturnType<typeof fixture>) =>
  Object.fromEntries(Object.entries(f.session.forHand('1000001')).map(([k, v]) => ['p_' + k, v]));
test('writer observation requires synchronous fence, freezes all observations, and records construction coverage', async () => {
  const f = fixture();
  await assert.rejects(f.session.inspectOriginalWriters(), /fence_required/);
  await f.session.admit();
  await f.session.allocate();
  f.session.fenceForRetirement();
  assert.equal(f.session.canStart(), false);
  const o = await f.session.inspectOriginalWriters();
  assert.equal(o.coverage, 'captured-before-first-writer');
  assert.deepEqual(
    o.writers.map((w) => [w.kind, w.attempt, w.state]),
    [
      ['admission', 1, 'returned'],
      ['allocator', 2, 'returned'],
    ]
  );
  assert(Object.isFrozen(o) && Object.isFrozen(o.writers) && o.writers.every(Object.isFrozen));
  await assert.rejects(f.session.allocate());
  assert.equal((await f.session.inspectOriginalWriters()).writers.length, 2);
});
test('lost registration settles only after exact original canonical resolver success', async () => {
  const f = fixture();
  f.loseAdmission();
  await assert.rejects(f.session.admit());
  await f.session.admit();
  f.session.fenceForRetirement();
  const o = await f.session.inspectOriginalWriters();
  assert.equal(o.writers[0].state, 'positively-resolved');
  assert.equal(o.writers[0].operationId, f.identity.admission_id);
});
test('same durable allocator UUID retains distinct attempts and resolves only prior unknown', async () => {
  const f = fixture();
  await f.session.admit();
  f.loseAllocation();
  await assert.rejects(f.session.allocate());
  await f.session.allocate();
  f.session.fenceForRetirement();
  const ws = (await f.session.inspectOriginalWriters()).writers.filter(
    (w) => w.kind === 'allocator'
  );
  assert.deepEqual(
    ws.map((w) => [w.operationId, w.attempt, w.state]),
    [
      [id(10), 2, 'positively-resolved'],
      [id(10), 3, 'returned'],
    ]
  );
});
test('mismatching canonical resolver cannot clear unknown registration', async () => {
  const f = fixture();
  f.loseAdmission();
  await assert.rejects(f.session.admit());
  f.setMode(async () => ({
    data: { ok: true, ...f.identity, table_id: id(99), state: 'ACTIVE', revision: '1' },
    error: null,
  }));
  await assert.rejects(f.session.admit());
  f.session.fenceForRetirement();
  assert.equal((await f.session.inspectOriginalWriters()).writers[0].state, 'unknown');
});
test('independent concurrent raw BEGIN calls are physically joined with separate ordinals', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  const a = deferred<any>(),
    b = deferred<any>();
  let calls = 0;
  f.setMode(() => (++calls === 1 ? a.promise : b.promise));
  const one = f.session.begin(input);
  const two = f.session.begin(input);
  const failures = Promise.all([assert.rejects(one, /retired/), assert.rejects(two, /retired/)]);
  f.session.fenceForRetirement();
  let complete = false;
  const join = f.session.inspectOriginalWriters().then((o) => {
    complete = true;
    return o;
  });
  await Promise.resolve();
  assert.equal(complete, false);
  a.resolve({ data: { ok: true }, error: null });
  await Promise.resolve();
  assert.equal(complete, false);
  b.resolve({ data: { ok: true }, error: null });
  await failures;
  const o = await join;
  assert.deepEqual(
    o.writers.filter((w) => w.kind === 'begin').map((w) => [w.attempt, w.operationId, w.state]),
    [
      [3, id(10), 'returned'],
      [4, id(10), 'returned'],
    ]
  );
});
test('late raw rejection stays unknown after physical join', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  const d = deferred<any>();
  f.setMode(() => d.promise);
  const begin = f.session.begin(input);
  const failed = assert.rejects(begin, /late/);
  f.session.fenceForRetirement();
  const join = f.session.inspectOriginalWriters();
  d.reject(Error('late'));
  await failed;
  assert.equal((await join).writers.at(-1)?.state, 'unknown');
});
test('ownership loss during raw join refuses observation and retains unknown', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  const d = deferred<any>();
  f.setMode(() => d.promise);
  const begin = f.session.begin(input);
  const failed = assert.rejects(begin);
  f.session.fenceForRetirement();
  const join = f.session.inspectOriginalWriters();
  const refused = assert.rejects(join, /owner_changed/);
  f.setOwner(false);
  d.resolve({ data: null, error: 'lost' });
  await failed;
  await refused;
});
test('fence prevents queued admission from launching a raw registration', async () => {
  const f = fixture();
  const admission = f.session.admit();
  f.session.fenceForRetirement();
  await assert.rejects(admission, /retiring/);
  assert.deepEqual((await f.session.inspectOriginalWriters()).writers, []);
  assert.equal(f.calls.length, 0);
});
test('fence while admission resolver is pending prevents registration and joins serial completion', async () => {
  const f = fixture();
  const d = deferred<any>();
  f.setMode(() => d.promise);
  const admission = f.session.admit();
  const failed = assert.rejects(admission, /retiring/);
  await Promise.resolve();
  f.session.fenceForRetirement();
  let done = false;
  const joined = f.session.inspectOriginalWriters().then((o) => {
    done = true;
    return o;
  });
  await Promise.resolve();
  assert.equal(done, false);
  d.resolve({ data: { ok: true, ...f.identity, state: 'ELIGIBLE' }, error: null });
  await failed;
  assert.deepEqual((await joined).writers, []);
});
test('malformed raw reply is unknown, not positive resolution', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  f.setMode(async () => ({ data: null, error: null }));
  await assert.rejects(f.session.begin(input));
  f.session.fenceForRetirement();
  assert.equal((await f.session.inspectOriginalWriters()).writers.at(-1)?.state, 'unknown');
});

test('registration retries preserve admission UUID and distinct physical attempt records', async () => {
  const f = fixture();
  let registered = 0;
  f.setMode(async (name: any) =>
    name === 'fn_f06_resolve_engine_admission'
      ? {
          data: {
            ok: true,
            ...f.identity,
            state: 'ELIGIBLE',
            protocol_epoch: '1',
            enrollment_token: 'a'.repeat(64),
          },
          error: null,
        }
      : (++registered, { data: null, error: 'lost' })
  );
  await assert.rejects(f.session.admit());
  await assert.rejects(f.session.admit());
  f.session.fenceForRetirement();
  assert.equal(registered, 2);
  assert.deepEqual(
    (await f.session.inspectOriginalWriters()).writers.map((w) => [
      w.operationId,
      w.attempt,
      w.state,
    ]),
    [
      [f.identity.admission_id, 1, 'unknown'],
      [f.identity.admission_id, 2, 'unknown'],
    ]
  );
});
test('synchronous throwing transport is captured before invocation and physically settled', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  f.setMode(() => {
    f.session.fenceForRetirement();
    throw Error('sync');
  });
  await assert.rejects(f.session.begin(input), /sync/);
  assert.equal((await f.session.inspectOriginalWriters()).writers.at(-1)?.state, 'unknown');
});
test('fixed point includes serial work queued after join starts without joining enclosing caller', async () => {
  const f = fixture();
  await f.session.admit();
  f.session.fenceForRetirement();
  const d = deferred<any>();
  f.setMode(() => d.promise);
  let finished = false;
  const enclosing = (async () => {
    const observation = await f.session.inspectOriginalWriters();
    finished = true;
    return observation;
  })();
  const inspection = f.session.inspectQuarantine();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  d.resolve({ data: { ok: true, ...f.identity, state: 'ACTIVE', revision: '1' }, error: null });
  await inspection;
  assert.equal((await enclosing).writers.length, 1);
});
test('semantically refused returned object is transport observation, not canonical success', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  f.setMode(async () => ({ data: { ok: false, state: 'REFUSED' }, error: null }));
  await f.session.begin(input);
  f.session.fenceForRetirement();
  assert.equal((await f.session.inspectOriginalWriters()).writers.at(-1)?.state, 'returned');
});

test('same-key BEGIN refusal does not erase an earlier unknown and fencing prevents a third raw attempt', async () => {
  const f = fixture();
  await f.session.admit();
  await f.session.allocate();
  const input = beginInput(f);
  const lost = deferred<any>();
  let rawBegins = 0;
  f.setMode((name: string) => {
    assert.equal(name, 'fn_f06_begin_hand_with_intent');
    rawBegins++;
    return rawBegins === 1
      ? lost.promise
      : Promise.resolve({ data: { ok: false, state: 'REFUSED' }, error: null });
  });
  const first = f.session.begin(input);
  const firstFailure = assert.rejects(first, /lost begin/);
  const refused = await f.session.begin(input);
  assert.deepEqual(refused.data, { ok: false, state: 'REFUSED' });
  f.session.fenceForRetirement();
  let observed = false;
  // The real enclosing caller waits for observation, not vice versa.
  const caller = (async () => {
    const observation = await f.session.inspectOriginalWriters();
    observed = true;
    return observation;
  })();
  await assert.rejects(f.session.begin(input), /begin_unproven/);
  assert.equal(rawBegins, 2);
  assert.equal(observed, false); // Returned refusal did not settle the first raw call.
  lost.reject(Error('lost begin'));
  await firstFailure;
  const observation = await caller;
  const expected = [
    {
      kind: 'begin',
      rpc: 'fn_f06_begin_hand_with_intent',
      operationId: id(10),
      attempt: 3,
      engineWriterOrigin: null,
      admissionRevision: '1',
      handNumber: '1000001',
      state: 'unknown',
    },
    {
      kind: 'begin',
      rpc: 'fn_f06_begin_hand_with_intent',
      operationId: id(10),
      attempt: 4,
      engineWriterOrigin: null,
      admissionRevision: '1',
      handNumber: '1000001',
      state: 'returned',
    },
  ];
  assert.deepEqual(
    observation.writers.filter((w) => w.kind === 'begin'),
    expected
  );
  assert.equal(observation.lastAttempt, 4);
  // Read-only repeat does not collapse attempts or reinterpret returned as success.
  assert.deepEqual(await f.session.inspectOriginalWriters(), observation);
  assert.equal(rawBegins, 2);
});
