import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssignmentBrowserIdentity, observeAssignmentPrivateChannel } from './qualify-agent-assignment-browser.mjs';
const club='a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
const account={id:'11111111-1111-4111-8111-111111111111',email:'ca-customization-cert-postdeploy-fixture@example.invalid'};
const session={user:{id:account.id,email:account.email},access_token:'fixture-access',refresh_token:'fixture-refresh'};
test('browser proof permits only the existing reserved identity and club',()=>{
 assert.doesNotThrow(()=>validateAssignmentBrowserIdentity(account,session,club));
 assert.throws(()=>validateAssignmentBrowserIdentity({...account,email:'person@example.com'},session,club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,session,'unrelated-club'));
});
test('browser proof refuses missing, cross-user or incomplete sessions before launching Chromium',()=>{
 assert.throws(()=>validateAssignmentBrowserIdentity(account,null,club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,user:{...session.user,id:'another-user'}},club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,user:{...session.user,email:'someone@example.invalid'}},club));
 assert.throws(()=>validateAssignmentBrowserIdentity(account,{...session,refresh_token:null},club));
});

// The real maintained observer receives the same page/socket events as Playwright.
import { EventEmitter } from 'node:events';
function observed() {
  const frame = {};
  const page = new EventEmitter();
  page.mainFrame = () => frame;
  const messages = [];
  const observation = observeAssignmentPrivateChannel(page, account.id, (message) =>
    messages.push(message)
  );
  const documentRequest = (target = frame) =>
    page.emit('request', { isNavigationRequest: () => true, frame: () => target });
  const socket = () => {
    const connection = new EventEmitter();
    page.emit('websocket', connection);
    return connection;
  };
  const ack = (connection, id = account.id) =>
    connection.emit('framereceived', {
      payload: JSON.stringify({
        topic: 'realtime:profile-account:' + id,
        event: 'phx_reply',
        payload: { status: 'ok' },
      }),
    });
  return { page, frame, observation, documentRequest, socket, ack, messages };
}
async function hasJoined(observation) {
  let done = false;
  observation.joined.then(() => {
    done = true;
  });
  await Promise.resolve();
  return done;
}
test('an owned private join ACK survives same-document history navigation', async () => {
  const f = observed();
  f.documentRequest();
  f.page.emit('framenavigated', f.frame);
  const socket = f.socket();
  f.ack(socket);
  assert.equal(await hasJoined(f.observation), true);
  f.page.emit('framenavigated', f.frame); // history.pushState changes the URL without a document request
  assert.equal(await hasJoined(f.observation), true);
  assert.equal(
    f.observation.navigationCount,
    2,
    'History navigation still counts for the no-navigation proof'
  );
});
test('a real document request retires the old socket ACK and requires a new owned join', async () => {
  const f = observed();
  f.documentRequest();
  f.page.emit('framenavigated', f.frame);
  const old = f.socket();
  f.ack(old);
  assert.equal(await hasJoined(f.observation), true);
  f.documentRequest();
  f.ack(old);
  assert.equal(
    await hasJoined(f.observation),
    false,
    'The request retires old evidence before document commit'
  );
  f.page.emit('framenavigated', f.frame);
  f.ack(old);
  assert.equal(
    await hasJoined(f.observation),
    false,
    'Old socket cannot prove the replacement document joined'
  );
  const replacement = f.socket();
  f.ack(replacement);
  assert.equal(await hasJoined(f.observation), true);
});
test('ordinary fetches and iframe navigation do not retire the owned join', async () => {
  const f = observed();
  const socket = f.socket();
  f.ack(socket);
  f.page.emit('request', {
    isNavigationRequest: () => false,
    frame: () => {
      throw Error('Not a navigation');
    },
  });
  f.documentRequest({});
  f.page.emit('framenavigated', {});
  assert.equal(await hasJoined(f.observation), true);
  assert.equal(f.observation.navigationCount, 0);
});
test('unrelated account ACKs do not prove the private source account joined', async () => {
  const f = observed();
  const socket = f.socket();
  f.ack(socket, 'another-account');
  assert.equal(await hasJoined(f.observation), false);
  assert.deepEqual(f.messages, []);
});

test('frames from the retired document cannot supply a later scope broadcast', () => {
  const f = observed();
  const old = f.socket();
  f.documentRequest();
  const frame = {
    payload: JSON.stringify({
      topic: 'realtime:profile-account:' + account.id,
      event: 'broadcast',
      payload: { event: 'account_changed', payload: { reason: 'member_scope_changed' } },
    }),
  };
  old.emit('framereceived', frame);
  assert.deepEqual(f.messages, []);
  const current = f.socket();
  current.emit('framereceived', frame);
  assert.equal(f.messages.length, 1);
});

test('a pending join waiter follows the replacement document without accepting the old socket', async () => {
  const f = observed();
  f.documentRequest();
  const old = f.socket();
  const pending = f.observation.joined;
  let resolved = false;
  pending.then(() => {
    resolved = true;
  });
  f.documentRequest();
  assert.equal(
    f.observation.joined,
    pending,
    'Document replacement must not abandon a pending proof waiter'
  );
  f.ack(old);
  await Promise.resolve();
  assert.equal(resolved, false, 'Retired socket cannot satisfy the pending proof');
  f.page.emit('framenavigated', f.frame);
  const replacement = f.socket();
  f.ack(replacement);
  await pending;
  assert.equal(resolved, true);
});
