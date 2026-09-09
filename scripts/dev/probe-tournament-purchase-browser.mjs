import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const bundled = await build({
  entryPoints: [resolve('src/services/TournamentPurchaseIntent.ts')],
  bundle: true,
  write: false,
  format: 'esm',
});
let state;
const server = createServer(async (req, res) => {
  if (req.url === '/bundle.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(bundled.outputFiles[0].text);
  }
  if (req.url === '/quote') {
    state.reads++;
    res.setHeader('Content-Type', 'application/json');
    return res.end(
      JSON.stringify({
        p_tournament_id: 'event',
        p_user_id: 'player',
        p_rebuy_type: state.kind,
        p_cost: state.requests.length ? 50 : 10,
        p_chips: 1000,
        p_current_level: state.requests.length ? 99 : 3,
        p_client_token: null,
      })
    );
  }
  if (req.url === '/submit') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.requests.push(JSON.parse(raw));
    res.setHeader('Content-Type', 'application/json');
    if (state.requests.length === 1) {
      if (state.mode === 'lost') return res.end('{');
      state.release = () => res.end(JSON.stringify({ new_stack: 0 }));
      return;
    }
    return res.end(JSON.stringify({ new_stack: 0 }));
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><title>Isolated Tournament Purchase Test</title><script type="module">' +
      'import {withTournamentPurchaseIntent} from "/bundle.js";' +
      'window.purchase=kind=>withTournamentPurchaseIntent({userId:"player",tournamentId:"event",kind:kind==="addon"?"addon":"rebuy"},' +
      'async()=>await(await fetch("/quote")).json(),' +
      'async request=>(await(await fetch("/submit",{method:"POST",body:JSON.stringify(request)})).json()).new_stack);' +
      '</script>'
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
async function open(context) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.purchase);
  return page;
}
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Browser Purchase Test Timed Out');
    await new Promise((r) => setTimeout(r, 25));
  }
}
try {
  for (const kind of ['rebuy', 'reentry', 'addon']) {
    for (const mode of ['lost', 'concurrent']) {
      state = { kind, mode, reads: 0, requests: [], release: null };
      const context = await browser.newContext();
      const one = await open(context);
      if (mode === 'lost') {
        await assert.rejects(one.evaluate((kind) => window.purchase(kind), kind));
        await one.reload();
        await one.waitForFunction(() => !!window.purchase);
        assert.equal(await one.evaluate((kind) => window.purchase(kind), kind), 0);
      } else {
        const two = await open(context);
        const first = one.evaluate((kind) => window.purchase(kind), kind);
        await until(() => !!state.release);
        const second = two.evaluate((kind) => window.purchase(kind), kind);
        await until(() =>
          two.evaluate(async () => (await navigator.locks.query()).pending.length > 0)
        );
        state.release();
        assert.deepEqual(await Promise.all([first, second]), [0, 0]);
      }
      assert.equal(state.reads, 1, 'Retry Must Not Recompute Quote Or Level');
      assert.equal(state.requests.length, 2);
      assert.deepEqual(
        state.requests[1],
        state.requests[0],
        'Retry Must Preserve Complete Request'
      );
      assert.equal(state.requests[0].p_current_level, 3);
      assert.equal(state.requests[0].p_cost, 10);
      if (kind !== 'addon') assert.match(state.requests[0].p_client_token, /^[0-9a-f-]{36}$/);
      await context.close();
    }
  }
  console.log(
    'PASS: Six Native Chromium Purchase Scenarios, Real Web Locks And Reloaded Storage; No Production Transactions'
  );
} finally {
  state?.release?.();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
