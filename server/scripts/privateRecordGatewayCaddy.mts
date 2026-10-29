/** Real Caddy + Unix-socket WebSocket qualification. No production endpoints/credentials. */
import { createServer, get } from 'node:http';
import { once } from 'node:events';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  renameSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { WebSocket, WebSocketServer } from 'ws';
const binary = process.env.CADDY_BIN;
const parent = process.env.RUNNER_TEMP ?? process.env.PRIVATE_RECORD_HOSTING_WORK;
if (!binary || !parent) throw new Error('explicit CADDY_BIN and owned scratch parent required');
const root = mkdtempSync(join(parent, 'gateway-route-'));
const servers: ReturnType<typeof createServer>[] = [];
const socketServers: WebSocketServer[] = [];
const peers: WebSocket[] = [];
let caddy: ReturnType<typeof spawn> | undefined;
let logs = '';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function backend(name: string) {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name, path: req.url }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ backend: name }));
    ws.on('message', (data) => ws.send(data));
  });
  const path = join(root, `${name}.sock`);
  server.listen(path);
  await once(server, 'listening');
  servers.push(server);
  socketServers.push(wss);
  return path;
}
async function fetchLocal(port: number, path: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (x) => (body += x));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('local Caddy deadline')));
  });
}
async function connect(port: number) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/private-record/ws/channel`,
    ['bearer', 'fixture.header.mustnotappear'],
    { origin: 'https://smarter.poker' }
  );
  peers.push(ws);
  const first = once(ws, 'message');
  await once(ws, 'open');
  return { ws, frame: JSON.parse(String((await first)[0])) };
}
try {
  const first = await backend('old');
  const second = await backend('new');
  const active = join(root, 'active.sock');
  symlinkSync(first, active);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((r) => reservation.close(() => r()));
  const repository = resolve(import.meta.dirname, '../..');
  let config = readFileSync(join(repository, 'infra/ca-origin/Caddyfile'), 'utf8');
  config = config
    .replace('{\n', '{\n\tadmin off\n\tauto_https off\n')
    .replace('ca-static.smarter.poker {', `http://127.0.0.1:${port} {`)
    .replaceAll('/run/ca-private-record-gateway/active.sock', active);
  writeFileSync(join(root, 'Caddyfile'), config);
  for (const name of ['config', 'data', 'cache', 'home']) mkdirSync(join(root, name));
  caddy = spawn(binary, ['run', '--config', join(root, 'Caddyfile'), '--adapter', 'caddyfile'], {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      HOME: join(root, 'home'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  caddy.stdout!.on('data', (x) => (logs += String(x)));
  caddy.stderr!.on('data', (x) => (logs += String(x)));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetchLocal(port, '/private-record/health')).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await wait(50);
  }
  assert(ready, 'local Caddy did not become ready');
  const old = await connect(port);
  assert.equal(old.frame.backend, 'old');
  const next = join(root, 'next.sock');
  symlinkSync(second, next);
  renameSync(next, active);
  const current = await connect(port);
  assert.equal(current.frame.backend, 'new');
  const oldReply = once(old.ws, 'message');
  old.ws.send('existing socket remains attached');
  assert.equal(String((await oldReply)[0]), 'existing socket remains attached');
  const health = await fetchLocal(port, '/private-record/health');
  assert.equal(JSON.parse(health.body).path, '/health');
  symlinkSync(first, next);
  renameSync(next, active);
  const rolledBack = await connect(port);
  assert.equal(rolledBack.frame.backend, 'old');
  symlinkSync(join(root, 'missing.sock'), next);
  renameSync(next, active);
  const refusal = new WebSocket(
    `ws://127.0.0.1:${port}/private-record/ws/channel`,
    ['bearer', 'fixture.header.mustnotappear'],
    { origin: 'https://smarter.poker' }
  );
  peers.push(refusal);
  refusal.on('error', () => {});
  const rejected = once(refusal, 'unexpected-response');
  assert.equal((await rejected)[1].statusCode, 502);
  refusal.terminate();
  await wait(50);
  assert(
    !logs.includes('fixture.header.mustnotappear'),
    'Caddy error log leaked credential-bearing subprotocol'
  );
  console.log(
    'PRIVATE_RECORD_CADDY PASS: path stripping, actual Unix WebSocket upgrade, atomic switch, existing socket continuity, reversal, error-log credential redaction'
  );
} finally {
  peers.forEach((ws) => ws.terminate());
  socketServers.forEach((wss) => {
    wss.clients.forEach((ws) => ws.terminate());
    wss.close();
  });
  await Promise.all(servers.map((server) => new Promise<void>((r) => server.close(() => r()))));
  if (caddy && caddy.exitCode === null) {
    const exited = once(caddy, 'exit');
    caddy.kill('SIGTERM');
    await exited;
  }
  rmSync(root, { recursive: true, force: true });
}
