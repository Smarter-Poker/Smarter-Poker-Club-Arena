import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { admissionHandler } from '../../operations/release/event-admission.mjs';

async function start(callbacks) {
  const server = http.createServer(
    admissionHandler({ repositories: ['Smarter-Poker/Smarter-Poker-Club-Arena'], ...callbacks })
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
const post = (url, body = {}, authorization = 'Bearer fixture') =>
  fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
test('installed ingress routes certificate and same-run static callbacks to their authorities and preserves original request identity', async () => {
  const calls = [];
  const fixture = await start({
    certificateCallback: {
      handle: async (input) => {
        calls.push(['certificate', input]);
        return { cleanup_complete: true };
      },
    },
    staticPublicationCallback: {
      handle: async (input) => {
        calls.push(['static', input]);
        return { may_publish: false };
      },
    },
  });
  try {
    const body = { operation_id: 'original', action: 'snapshot' };
    const certificate = await post(fixture.url + '/certification', body);
    assert.equal(certificate.status, 200);
    assert.deepEqual(await certificate.json(), { cleanup_complete: true });
    const publish = await post(fixture.url + '/static-publication', { claim_key: 'immutable' });
    assert.equal(publish.status, 200);
    assert.deepEqual(await publish.json(), { may_publish: false });
    assert.deepEqual(calls, [
      ['certificate', { authorization: 'Bearer fixture', body }],
      ['static', { authorization: 'Bearer fixture', body: { claim_key: 'immutable' } }],
    ]);
    assert.equal((await post(fixture.url + '/unowned')).status, 503);
    assert.equal((await fetch(fixture.url + '/certification')).status, 503);
    assert.equal(calls.length, 2);
  } finally {
    await fixture.close();
  }
});
test('callback in flight excludes a concurrent publisher and failure releases the ingress without exposing diagnostics', async () => {
  let release,
    entered,
    callCount = 0;
  const admitted = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = await start({
    certificateCallback: {
      handle: async () => {
        callCount++;
        entered();
        await held;
        throw new Error('sensitive remote details');
      },
    },
    staticPublicationCallback: {
      handle: async () => {
        callCount++;
        return { may_publish: false };
      },
    },
  });
  try {
    const first = post(fixture.url + '/certification');
    await admitted;
    assert.equal((await post(fixture.url + '/static-publication')).status, 503);
    assert.equal(callCount, 1);
    release();
    const failed = await first;
    assert.equal(failed.status, 400);
    assert.deepEqual(await failed.json(), { accepted: false });
    assert.equal((await post(fixture.url + '/static-publication')).status, 200);
    assert.equal(callCount, 2);
  } finally {
    release();
    await fixture.close();
  }
});
test('oversized or malformed callback body never reaches either mutation authority', async () => {
  let calls = 0;
  const fixture = await start({
    certificateCallback: {
      handle: async () => {
        calls++;
        return {};
      },
    },
  });
  try {
    assert.equal(
      (await post(fixture.url + '/certification', { payload: 'x'.repeat(65537) })).status,
      400
    );
    const response = await fetch(fixture.url + '/certification', {
      method: 'POST',
      body: '{broken',
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    await fixture.close();
  }
});

test('admission verifies exact isolated submitter and authenticated TLS before enqueue authority', async () => {
  const { verifyAdmissionPrincipal } = await import('../../operations/release/event-admission.mjs');
  let calls = 0;
  const client = {
    connection: { stream: { encrypted: true, authorized: true } },
    query: async () => {
      calls++;
      return { rows: [{ rolname: 'submitter_fixture', allowed: true }] };
    },
  };
  await verifyAdmissionPrincipal(client, 'submitter_fixture');
  await assert.rejects(verifyAdmissionPrincipal(client, 'other_submitter'));
  client.connection.stream.authorized = false;
  await assert.rejects(verifyAdmissionPrincipal(client, 'submitter_fixture'));
  assert.equal(calls, 2);
  client.connection.stream.authorized = true;
  client.query = async () => ({ rows: [{ rolname: 'submitter_fixture', allowed: false }] });
  await assert.rejects(verifyAdmissionPrincipal(client, 'submitter_fixture'));
});
