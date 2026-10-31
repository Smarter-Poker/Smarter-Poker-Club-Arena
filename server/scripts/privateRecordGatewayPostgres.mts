/** Native local-only qualification, called by the existing member-record PostgreSQL suite. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import { WebSocket } from 'ws';
import { PRIVATE_RECORD_GATEWAY_ORIGINS } from '../src/transport/privateRecordGatewayRuntime.js';
import { PrivateRecordGateway } from '../src/transport/PrivateRecordGateway.js';
import { PrivateRecordListener } from '../src/services/supabase/privateRecordListener.js';
const host = process.argv[2];
const port = Number(process.argv[3]);
if (!host?.startsWith('/') || !Number.isInteger(port))
  throw new Error('native fixture requires an explicit Unix socket');
const config = {
  host,
  port,
  database: 'postgres',
  user: 'fixture_admin',
  connectionTimeoutMillis: 3000,
};
const database = new pg.Client(config);
await database.connect();
const club = '81000000-0000-0000-0000-000000000001';
const user = '81000000-0000-0000-0000-000000000002';
const roster = `club-roster:${club}`;
const member = `member-record:${club}:${user}`;
let session: pg.Client;
const frames: any[] = [];
let socket: WebSocket | undefined;
const gateway = new PrivateRecordGateway({
  origins: PRIVATE_RECORD_GATEWAY_ORIGINS,
  // Only GoTrue is replaced. Actual topic authorization runs as authenticated in native PG.
  authenticate: async () => ({ userId: user }),
  authorize: async (_token, actor, topic) => {
    const client = new pg.Client(config);
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('test.viewer',$1,true)", [actor]);
      await client.query('SET LOCAL ROLE authenticated');
      const fn = topic.startsWith('club-roster:')
        ? 'ca_club_roster_can_subscribe'
        : 'ca_member_record_can_subscribe';
      const result = await client.query(`SELECT public.${fn}($1) AS allowed`, [topic]);
      await client.query('ROLLBACK');
      return result.rows[0].allowed === true;
    } finally {
      await client.end();
    }
  },
  source: (changed, readiness) =>
    new PrivateRecordListener(
      changed,
      readiness,
      async () => 'local-unix-socket',
      () => {
        session = new pg.Client(config);
        return session;
      },
      async () =>
        (await database.query('SELECT fn_private_record_transport_ready() AS ready')).rows[0]
          .ready === true
    ),
});
const server = createServer();
gateway.attach(server);
// The native realtime.send substitute records the exact provider handoff. This
// proves the legacy producer contract, not hosted Supabase WebSocket receipt.
async function paidCompatibility(phase: string): Promise<void> {
  assert.equal(
    (
      await database.query(
        'SELECT supabase_enabled FROM ca_private_record_transport_state WHERE singleton'
      )
    ).rows[0].supabase_enabled,
    true,
    phase
  );
  await database.query('TRUNCATE signals');
  await database.query('BEGIN');
  try {
    await database.query('SELECT fn_publish_club_roster($1),fn_publish_club_roster($1)', [club]);
    await database.query(
      'SELECT fn_publish_member_record_topic($1,$2::jsonb),fn_publish_member_record_topic($1,$2::jsonb)',
      [member, JSON.stringify({ user_id: user })]
    );
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK');
    throw error;
  }
  const rows = (
    await database.query(
      'SELECT topic,payload,event,private FROM signals WHERE topic=ANY($1::text[]) ORDER BY topic',
      [[roster, member]]
    )
  ).rows;
  assert.deepEqual(
    rows,
    [
      { topic: roster, payload: {}, event: 'record_changed', private: true },
      { topic: member, payload: { user_id: user }, event: 'record_changed', private: true },
    ],
    `${phase}: exact historical paid handoff, once per topic/transaction`
  );
  await database.query('BEGIN');
  await database.query('SELECT fn_publish_club_roster($1)', [club]);
  await database.query('ROLLBACK');
  assert.equal(
    Number((await database.query('SELECT count(*) AS n FROM signals')).rows[0].n),
    2,
    `${phase}: no rolled-back legacy signal`
  );
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('native origin handshake deadline')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
function next(predicate: (frame: any) => boolean): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket!.off('message', receive);
      reject(new Error('native gateway frame deadline'));
    }, 5000);
    function receive(raw: unknown) {
      const frame = JSON.parse(String(raw));
      if (predicate(frame)) {
        clearTimeout(timer);
        socket!.off('message', receive);
        resolve(frame);
      }
    }
    socket!.on('message', receive);
  });
}
try {
  await database.query('INSERT INTO clubs(id,name) VALUES($1,$2)', [club, 'Gateway Fixture']);
  await database.query("INSERT INTO profiles(id,status) VALUES($1,'active')", [user]);
  await database.query(
    "INSERT INTO club_members(club_id,user_id,status,role) VALUES($1,$2,'active','player')",
    [club, user]
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/channel`,
    ['bearer', 'native.fixture.signature'],
    { origin: 'https://smarter.poker' }
  );
  socket.on('error', () => {});
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await once(socket, 'open');
  for (const topic of [roster, member]) {
    const ready = next((frame) => frame.topic === topic && frame.ready === true);
    socket.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic }));
    await ready;
  }
  const dual = [
    next((frame) => frame.topic === roster && frame.type === 'PRIVATE_RECORD_CHANGED'),
    next((frame) => frame.topic === member && frame.type === 'PRIVATE_RECORD_CHANGED'),
  ];
  await paidCompatibility('gateway coexistence');
  await Promise.all(dual);
  // Native WebSocket origins use the exact production entry-point allowlist.
  for (const origin of ['capacitor://localhost', 'https://localhost']) {
    const native = new WebSocket(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/channel`,
      ['bearer', 'native.fixture.signature'],
      { origin }
    );
    try {
      await bounded(once(native, 'open'));
      const ready = once(native, 'message');
      native.send(JSON.stringify({ type: 'JOIN_PRIVATE_RECORD', topic: roster }));
      const message = JSON.parse(String((await bounded(ready))[0]));
      assert.equal(message.ready, true);
      assert.equal(message.topic, roster);
    } finally {
      native.terminate();
    }
  }
  await database.query(
    'UPDATE ca_private_record_transport_state SET supabase_enabled=false WHERE singleton'
  );
  const paidBefore = Number((await database.query('SELECT count(*) AS n FROM signals')).rows[0].n);
  frames.length = 0;
  const update = next((frame) => frame.topic === roster && frame.type === 'PRIVATE_RECORD_CHANGED');
  await database.query('BEGIN');
  await database.query('SELECT fn_publish_club_roster($1),fn_publish_club_roster($1)', [club]);
  await database.query('COMMIT');
  await update;
  assert.equal(
    frames.filter((frame) => frame.topic === roster && frame.type === 'PRIVATE_RECORD_CHANGED')
      .length,
    1
  );
  await database.query('BEGIN');
  await database.query('SELECT fn_publish_club_roster($1)', [club]);
  await database.query('ROLLBACK');
  const barrier = next(
    (frame) => frame.topic === member && frame.type === 'PRIVATE_RECORD_CHANGED'
  );
  await database.query("SELECT fn_publish_member_record_topic($1,'{}')", [member]);
  await barrier;
  assert.equal(
    frames.filter((frame) => frame.topic === roster && frame.type === 'PRIVATE_RECORD_CHANGED')
      .length,
    1,
    'rollback must not publish'
  );
  assert.equal(
    Number((await database.query('SELECT count(*) AS n FROM signals')).rows[0].n),
    paidBefore,
    'paid disabled must leave gateway delivery intact'
  );
  await database.query(
    'UPDATE ca_private_record_transport_state SET supabase_enabled=true WHERE singleton'
  );
  const unavailable = next((frame) => frame.topic === roster && frame.ready === false);
  await session!.end();
  await unavailable;
  const recovered = next((frame) => frame.topic === roster && frame.ready === true);
  await recovered;
  await paidCompatibility('listener recovery and returning legacy client');
  const closed = once(socket, 'close');
  await database.query("UPDATE club_members SET status='removed' WHERE club_id=$1 AND user_id=$2", [
    club,
    user,
  ]);
  assert.equal((await closed)[0], 4403);
  await gateway.close();
  await paidCompatibility('gateway stopped; cached/native legacy source retained');
  console.log(
    'PRIVATE_RECORD_LEGACY_COMPATIBILITY PASS: exact paid handoff with gateway live/recovered/stopped, rollback/dedup and native origins; provider delivery and installed apps NOT certified'
  );
  console.log(
    'PRIVATE_RECORD_GATEWAY_POSTGRES PASS: native commit to WebSocket, dedup, rollback, paid-off delivery, listener recovery, fresh ACL refusal; no engine instantiated'
  );
} finally {
  socket?.terminate();
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await database.query(
    'UPDATE ca_private_record_transport_state SET supabase_enabled=true WHERE singleton'
  );
  await database.end();
}
