import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const table = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const user = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const original = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const replacement = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const bundled = await build({
  entryPoints: [resolve('src/services/SeatLeaveIntent.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  plugins: [
    {
      name: 'local-financial-fixtures',
      setup(b) {
        b.onResolve({ filter: /^(\.\.\/lib\/supabase|\.\/GameServerAPI)$/ }, (args) => ({
          path: args.path,
          namespace: 'fixture',
        }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
          loader: 'js',
          contents: args.path.includes('supabase')
            ? "const chain={select(){return this},eq(){return this},is(){return this},async maybeSingle(){return await (await fetch('/test-seat')).json()}};export const supabase={from(){return chain}};"
            : "async function send(body){return await (await fetch('/test-action',{method:'POST',body:JSON.stringify(body)})).json()} export function notifyServerLeaveOccupancy(tableId,seatNumber,occupancyId){return send({kind:'leave',tableId,seatNumber,occupancyId})} export function notifyServerKickOccupancy(tableId,userId,seatNumber,occupancyId,reason){return send({kind:'kick',tableId,userId,seatNumber,occupancyId,reason})}",
        }));
      },
    },
  ],
});
let state;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundled.outputFiles[0].text);
    return;
  }
  if (req.url === '/test-seat') {
    state.seatReads++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { seat_number: 2, occupancy_id: state.seat }, error: null }));
    return;
  }
  if (req.url === '/test-action') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push(body);
    const payload = {
      success: true,
      protocol: 'seat-occupancy-v1',
      occupancyId: body.occupancyId,
      seatNumber: 2,
      immediate: true,
      cashout: {
        ok: true,
        stack: body.occupancyId === original ? 25 : 40,
        credited: true,
        seat_number: 2,
        occupancy_id: body.occupancyId,
        user_id: user,
        table_id: table,
        tournament_table: false,
        idempotency_key: 'cashout:occupancy:' + body.occupancyId,
      },
    };
    res.setHeader('Content-Type', 'application/json');
    if (state.requests.length === 1) {
      state.seat = replacement;
      if (state.mode === 'hold') {
        state.release = () => res.end(JSON.stringify(payload));
        return;
      }
      if (state.mode === 'truncated') {
        res.end('{');
        return;
      }
    }
    res.end(JSON.stringify(payload));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Isolated seat intent fixture</title><script type="module">import * as intent from "/bundle.js";window.intent=intent;</script>'
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function waitFor(check, label) {
  const until = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('Timed out: ' + label);
    await new Promise((r) => setTimeout(r, 25));
  }
}
async function open(context) {
  const p = await context.newPage();
  await p.goto(origin);
  await p.waitForFunction(() => !!window.intent);
  return p;
}
function act(p, kind, reason = 'original reason') {
  return p.evaluate(
    ({ table, user, kind, reason }) =>
      kind === 'leave'
        ? window.intent.leaveSeatWithIntent(table, user)
        : window.intent.kickSeatWithIntent(table, user, reason),
    { table, user, kind, reason }
  );
}
try {
  for (const kind of ['leave', 'kick']) {
    for (const timing of ['pending', 'before-persist']) {
      const context = await browser.newContext();
      state = { mode: 'hold', seat: original, requests: [], seatReads: 0, release: null };
      const one = await open(context),
        two = await open(context);
      if (timing === 'before-persist') {
        await one.evaluate(
          ({ key }) => {
            window.fixtureLock = navigator.locks.request(
              key,
              () =>
                new Promise((resolve) => {
                  window.releaseFixtureLock = resolve;
                })
            );
          },
          { key: 'ca:seat-' + kind + ':v1:' + user + ':' + table }
        );
        await one.waitForFunction(() => !!window.releaseFixtureLock);
      }
      const first = act(one, kind);
      if (timing === 'pending') await waitFor(() => state.requests.length === 1, 'first action');
      else
        await waitFor(
          async () =>
            await two.evaluate(async () => (await navigator.locks.query()).pending.length === 1),
          'first queued before persistence'
        );
      const second = act(two, kind, 'later reason');
      await waitFor(
        async () =>
          (await two.evaluate(async () => (await navigator.locks.query()).pending.length)) >=
          (timing === 'pending' ? 1 : 2),
        'second queued'
      );
      if (timing === 'before-persist') {
        await one.evaluate(() => window.releaseFixtureLock());
        await waitFor(() => state.requests.length === 1, 'first action after lock release');
      }
      state.release();
      assert.deepEqual(
        await Promise.all([first, second]),
        [
          { success: true, chipsReturned: 25 },
          { success: true, chipsReturned: 25 },
        ],
        kind + ' ' + timing + ' must return original outcome'
      );
      assert.deepEqual(
        state.requests.map((x) => x.occupancyId),
        [original, original],
        kind + ' cannot target replacement'
      );
      assert.equal(state.seatReads, 1, kind + ' queued action must not discover replacement');
      await context.close();
    }
    const reloadContext = await browser.newContext();
    state = { mode: 'truncated', seat: original, requests: [], seatReads: 0, release: null };
    const p = await open(reloadContext);
    assert.equal((await act(p, kind)).success, false);
    await p.reload();
    await p.waitForFunction(() => !!window.intent);
    assert.deepEqual(await act(p, kind, 'changed after reload'), {
      success: true,
      chipsReturned: 25,
    });
    assert.deepEqual(
      state.requests.map((x) => x.occupancyId),
      [original, original]
    );
    assert.equal(state.seatReads, 1);
    if (kind === 'kick')
      assert.deepEqual(
        state.requests.map((x) => x.reason),
        ['original reason', 'original reason']
      );
    await reloadContext.close();
  }
  console.log(
    'PASS: native Chromium Web Locks across tabs, localStorage across reload, original leave/kick identities and kick reason'
  );
} finally {
  state?.release?.();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
