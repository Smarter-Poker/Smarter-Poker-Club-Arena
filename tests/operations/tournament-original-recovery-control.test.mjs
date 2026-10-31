import test from 'node:test';
import assert from 'node:assert/strict';
import { controlOriginalRecovery } from '../../.github/scripts/tournament-original-recovery-control.mjs';
const input = {
  action: 'prepare',
  tournamentId: '095d7449-3282-46c5-8a39-768fe14dce5a',
  nonce: '13000000-0000-4000-8000-000000000001',
  generation: 'ab000000-0000-4000-8000-000000000001',
  instance: '1-1234abcd',
  sha: '1234567890123456789012345678901234567890',
};
const health = {
  releaseSha: input.sha,
  version: input.sha.slice(0, 8),
  instanceId: input.instance,
  running: true,
  status: 'ok',
  maintenance: { active: false, phase: 'idle' },
};
const runtime = {
  state: 'prepared',
  operation_id: 'd44c4440-2911-430c-8ee7-376611ef3f38',
  tournament_id: input.tournamentId,
  nonce: input.nonce,
  current_generation: input.generation,
  instance_id: input.instance,
  release_sha: input.sha,
  abort_fenced: true,
  custody_certified: false,
  disposition_committed: false,
};
function fixture(change = {}) {
  const calls = [];
  let reads = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      if (change.timeout) throw Error('unknown');
      return {
        ok: true,
        json: async () => ({ success: true, runtime: { ...runtime, ...change.runtime } }),
      };
    }
    return {
      ok: true,
      json: async () => ({ ...health, ...(++reads === 2 ? change.after : change.before) }),
    };
  };
  return { calls, fetchImpl };
}
test('one canonical service POST retains exact receipt and both actual identity reads', async () => {
  const f = fixture();
  const r = await controlOriginalRecovery(input, { ...f, serviceIdentity: 'isolated-key' });
  assert.equal(r.outcome, 'prepared_readback');
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].options.headers.authorization, 'Bearer isolated-key');
  assert.equal(JSON.stringify(r).includes('isolated-key'), false);
});
test('refuses wrong cohort before network', async () => {
  const f = fixture();
  await assert.rejects(
    controlOriginalRecovery(
      { ...input, tournamentId: '68000000-0000-4000-8000-000000000001' },
      { ...f, serviceIdentity: 'isolated-key' }
    )
  );
  assert.equal(f.calls.length, 0);
});
test('HTTP200 without exact nonce is unknown, never preparation proof', async () => {
  const f = fixture({ runtime: { nonce: 'changed' } });
  const r = await controlOriginalRecovery(input, { ...f, serviceIdentity: 'isolated-key' });
  assert.equal(r.outcome, 'unknown');
  assert.equal(f.calls.filter((x) => x.options.method === 'POST').length, 1);
});
test('lost ACK never retries a control request or exposes credentials', async () => {
  const f = fixture({ timeout: true });
  const r = await controlOriginalRecovery(input, { ...f, serviceIdentity: 'isolated-key' });
  assert.equal(r.outcome, 'unknown');
  assert.equal(f.calls.filter((x) => x.options.method === 'POST').length, 1);
  assert.equal(JSON.stringify(r).includes('isolated-key'), false);
});
test('changed serving instance prevents control before actuation', async () => {
  const f = fixture({ before: { instanceId: '1-deadbeef' } });
  assert.equal(
    (await controlOriginalRecovery(input, { ...f, serviceIdentity: 'isolated-key' })).outcome,
    'unknown'
  );
  assert.equal(f.calls.length, 1);
});
test('post-control identity drift cannot certify preparation', async () => {
  const f = fixture({ after: { instanceId: '1-deadbeef' } });
  assert.equal(
    (await controlOriginalRecovery(input, { ...f, serviceIdentity: 'isolated-key' })).outcome,
    'unknown'
  );
  assert.equal(f.calls.length, 3);
});
const other = '68af0f95-82f5-4047-b424-6780a4236f4d';
const db = 'https://kuklfnapbkmacvwxktbh.supabase.co';
function abortFixture({ timeout = false, hash = '0'.repeat(32), initiallySettled = false } = {}) {
  const calls = [];
  let mutated = initiallySettled;
  const state = () => ({
    ok: true,
    operation_id: runtime.operation_id,
    tournament_id: other,
    current_generation: input.generation,
    quiescence_generation: input.generation,
    current_boundary_valid: !mutated,
    money_hash: hash,
    state: mutated ? 'settled' : 'quiesced',
    tournament_status: mutated ? 'CANCELLED' : 'RUNNING',
    receipt: mutated
      ? {
          fully_settled: true,
          receipt_version: 3,
          mode: 'started_operator_abort',
          operation_id: runtime.operation_id,
          tournament_id: other,
        }
      : null,
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/health')) return { ok: true, json: async () => health };
    if (url.endsWith('/fn_ca_tournament_abort_stop_state'))
      return { ok: true, json: async () => state() };
    if (url.endsWith('/fn_ca_settle_tournament_abort')) {
      mutated = true;
      if (timeout) throw Error('lost ACK');
      return { ok: true, json: async () => ({ fully_settled: true }) };
    }
    throw Error('Unexpected route');
  };
  return { calls, fetchImpl };
}
test('other69 settlement uses only the existing canonical RPC and reviewed hash once', async () => {
  const f = abortFixture();
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_settle', tournamentId: other, moneyHash: '0'.repeat(32) },
    { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
  );
  assert.equal(r.outcome, 'original_abort_settled_readback');
  const writes = f.calls.filter((x) => x.url.endsWith('/fn_ca_settle_tournament_abort'));
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].options.body).p_expected_money_hash, '0'.repeat(32));
  assert.equal(JSON.stringify(r).includes('isolated-key'), false);
});
test('natural20 can never enter abort mutation modes', async () => {
  const f = abortFixture();
  await assert.rejects(
    controlOriginalRecovery(
      { ...input, action: 'abort_settle', moneyHash: '0'.repeat(32) },
      { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
    )
  );
  assert.equal(f.calls.length, 0);
});
test('lost settlement ACK stays unknown and reads its exact durable state without repayment', async () => {
  const f = abortFixture({ timeout: true });
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_settle', tournamentId: other, moneyHash: '0'.repeat(32) },
    { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
  );
  assert.equal(r.outcome, 'unknown');
  assert.equal(r.canonicalAfter.state, 'settled');
  assert.equal(f.calls.filter((x) => x.url.endsWith('/fn_ca_settle_tournament_abort')).length, 1);
});
test('changed review hash prevents any settlement RPC', async () => {
  const f = abortFixture({ hash: '1'.repeat(32) });
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_settle', tournamentId: other, moneyHash: '0'.repeat(32) },
    { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
  );
  assert.equal(r.outcome, 'unknown');
  assert.equal(f.calls.filter((x) => x.url.endsWith('/fn_ca_settle_tournament_abort')).length, 0);
});

test('abort ACK touches only the existing exact native boundary and rechecks canonical receipt', async () => {
  const f = abortFixture();
  const prior = f.fetchImpl;
  f.fetchImpl = async (url, options) => {
    if (url.endsWith('/admin/tournament-abort-boundary')) {
      f.calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({
          success: true,
          runtime: { state: 'acknowledged', operation_id: runtime.operation_id },
        }),
      };
    }
    return prior(url, options);
  };
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_ack', tournamentId: other },
    { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
  );
  assert.equal(r.outcome, 'original_abort_boundary_readback');
  const body = JSON.parse(
    f.calls.find((x) => x.url.endsWith('/admin/tournament-abort-boundary')).options.body
  );
  assert.deepEqual(Object.keys(body).sort(), ['operationId', 'tournamentId']);
  assert.equal(f.calls.filter((x) => x.url.includes('/fn_ca_settle_tournament_abort')).length, 0);
});
test('abort_read performs no native ACK or settlement', async () => {
  const f = abortFixture();
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_read', tournamentId: other },
    { ...f, serviceIdentity: 'isolated-key', supabaseUrl: db }
  );
  assert.equal(r.outcome, 'original_abort_readback');
  assert.equal(
    f.calls.filter(
      (x) => x.url.includes('/admin/') || x.url.endsWith('/fn_ca_settle_tournament_abort')
    ).length,
    0
  );
});
test('control workflow is manual default-branch free compute with canonical configured identity', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(
    new URL('../../.github/workflows/tournament-original-recovery-control.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(
    workflow,
    /^  (?:push|pull_request|schedule|workflow_run|repository_dispatch):/m
  );
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /secrets\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(workflow, /secrets\.SUPABASE_URL/);
  assert.doesNotMatch(
    workflow,
    /HETZNER_SSH|engine-release-transaction|stage-engine-release|repository_dispatch|\.env/
  );
});

// Synthetic private values must never reach the returned Actions artifact,
// including a partial result after a later identity/read failure.
const privateCanary = 'PRIVATE_PLAYER_ROSTER_LEDGER_SECRET_CANARY';
function privateResponses(f, { failAfter = false, badCanonicalAfter = false } = {}) {
  const prior = f.fetchImpl;
  let healthReads = 0;
  let canonicalReads = 0;
  f.fetchImpl = async (url, options) => {
    if (url.includes('/health') && ++healthReads === 2 && failAfter) throw Error(privateCanary);
    const response = await prior(url, options);
    return {
      ...response,
      json: async () => {
        const value = await response.json();
        const privateFields = {
          future_field: privateCanary,
          refunds: [{ user_id: privateCanary, ledger_id: privateCanary }],
          pre_abort_roster: [privateCanary],
          money_snapshot: { private_basis: privateCanary },
          refunded_count: { user_id: privateCanary },
          financial: {
            total_refunded: 123,
            unused_overlay_returned: 4,
            refunds: [{ user_id: privateCanary }],
            future: privateCanary,
          },
          quiescence: {
            generation: input.generation,
            money_hash: '0'.repeat(32),
            future: privateCanary,
          },
        };
        const poisoned = { ...value, ...privateFields };
        if (value.runtime) poisoned.runtime = { ...value.runtime, ...privateFields };
        if (value.receipt) poisoned.receipt = { ...value.receipt, ...privateFields };
        if (
          url.endsWith('/fn_ca_tournament_abort_stop_state') &&
          ++canonicalReads === 2 &&
          badCanonicalAfter
        )
          poisoned.current_generation = 'changed';
        return poisoned;
      },
    };
  };
  return f;
}
for (const scenario of [
  { name: 'prepare', action: 'prepare' },
  { name: 'read', action: 'read' },
  { name: 'prepare partial after identity failure', action: 'prepare', failAfter: true },
  { name: 'abort read', action: 'abort_read' },
  { name: 'abort read partial', action: 'abort_read', failAfter: true },
  { name: 'settlement already settled', action: 'abort_settle', initiallySettled: true },
  { name: 'abort settlement', action: 'abort_settle' },
  { name: 'settlement lost ACK', action: 'abort_settle', timeout: true },
  { name: 'settlement partial after identity failure', action: 'abort_settle', failAfter: true },
  { name: 'settlement partial canonical refusal', action: 'abort_settle', badCanonicalAfter: true },
  { name: 'abort ACK runtime', action: 'abort_ack' },
  { name: 'abort ACK runtime retired', action: 'abort_ack', initiallySettled: true },
  { name: 'abort ACK partial', action: 'abort_ack', failAfter: true },
  { name: 'abort ACK lost ACK', action: 'abort_ack', timeout: true },
]) {
  test(`public receipt excludes private/future fields: ${scenario.name}`, async () => {
    const abort = scenario.action.startsWith('abort_');
    const f = abort
      ? abortFixture({ timeout: scenario.timeout, initiallySettled: scenario.initiallySettled })
      : fixture();
    if (scenario.action === 'abort_ack') {
      const prior = f.fetchImpl;
      f.fetchImpl = async (url, options) => {
        if (!url.endsWith('/admin/tournament-abort-boundary')) return prior(url, options);
        f.calls.push({ url, options });
        if (scenario.timeout) throw Error(privateCanary);
        return {
          ok: true,
          json: async () => ({
            success: true,
            runtime: {
              state: 'acknowledged',
              operation_id: runtime.operation_id,
              runtime_retired: scenario.initiallySettled === true,
            },
          }),
        };
      };
    }
    privateResponses(f, scenario);
    const r = await controlOriginalRecovery(
      {
        ...input,
        action: scenario.action,
        tournamentId: abort ? other : input.tournamentId,
        moneyHash: '0'.repeat(32),
        unexpected_input: privateCanary,
      },
      { ...f, serviceIdentity: privateCanary, supabaseUrl: db }
    );
    assert.equal(JSON.stringify(r).includes(privateCanary), false);
    assert.doesNotMatch(
      JSON.stringify(r),
      /pre_abort_roster|money_snapshot|future_field|ledger_id|unexpected_input/
    );
    const actions = f.calls.filter(
      (x) => x.url.includes('/admin/') || x.url.endsWith('/fn_ca_settle_tournament_abort')
    );
    assert.equal(
      actions.length,
      scenario.action === 'abort_read' ||
        (scenario.action === 'abort_settle' && scenario.initiallySettled)
        ? 0
        : 1
    );
    if (scenario.name === 'abort ACK runtime retired')
      assert.equal(r.outcome, 'original_abort_runtime_retired');
    if (scenario.name === 'settlement already settled')
      assert.equal(r.outcome, 'original_abort_already_settled');
    if (!abort && r.outcome === 'prepared_readback') {
      const { response_digest, ...tuple } = r.runtime;
      assert.deepEqual(tuple, runtime);
      assert.match(response_digest.sha256, /^[a-f0-9]{64}$/);
    }
    if (r.settlement) assert.match(r.settlement.response_digest.sha256, /^[a-f0-9]{64}$/);
    if (r.canonicalBefore) assert.match(r.canonicalBefore.response_digest.sha256, /^[a-f0-9]{64}$/);
  });
}

test('legal BREAK state survives the public canonical projection without private basis', async () => {
  const f = privateResponses(abortFixture());
  const prior = f.fetchImpl;
  f.fetchImpl = async (url, options) => {
    const response = await prior(url, options);
    if (!url.endsWith('/fn_ca_tournament_abort_stop_state')) return response;
    return {
      ...response,
      json: async () => ({ ...(await response.json()), tournament_status: 'BREAK' }),
    };
  };
  const r = await controlOriginalRecovery(
    { ...input, action: 'abort_read', tournamentId: other },
    { ...f, serviceIdentity: privateCanary, supabaseUrl: db }
  );
  assert.equal(r.outcome, 'original_abort_readback');
  assert.equal(r.canonicalBefore.tournament_status, 'BREAK');
  assert.equal(r.canonicalAfter.tournament_status, 'BREAK');
  assert.equal(JSON.stringify(r).includes(privateCanary), false);
  assert.equal(
    f.calls.filter(
      (x) => x.url.includes('/admin/') || x.url.endsWith('/fn_ca_settle_tournament_abort')
    ).length,
    0
  );
});
