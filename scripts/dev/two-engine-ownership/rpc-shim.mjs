// A PostgREST-shaped RPC endpoint for ONE probe engine, in front of the
// isolated PostgreSQL 17 cluster. It speaks exactly the part of PostgREST the
// engine's lease code uses: POST /rest/v1/rpc/<function> with named JSON
// arguments, run as service_role in its own transaction; a set-returning
// function answers a JSON array of rows, a scalar answers the bare value, and
// an error answers 400 with PostgREST's {code, message, details, hint}.
//
// Each engine gets its own shim, so its network can fail on its own:
//   POST /__fault {"mode":"ok"}     deliver normally
//   POST /__fault {"mode":"hold"}   partition: accept requests, deliver nothing
//   POST /__fault {"mode":"heal"}   deliver every held request NOW, in order,
//                                   whether or not its caller is still waiting
//                                   (a late packet), then back to ok
// Every delivered statement and the database's answer is logged as a JSON line.
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(process.env.ENGINE_NODE_MODULES + '/');
const pg = require('pg');

const name = process.env.SHIM_NAME;
const port = Number(process.env.SHIM_PORT);
const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  max: 16,
});
let mode = 'ok';
const held = [];
const meta = new Map();
const log = (entry) => process.stdout.write(JSON.stringify({ t: Date.now(), shim: name, ...entry }) + '\n');
const IDENT = /^[a-z_][a-z0-9_]*$/;

async function functionShape(fn) {
  if (!meta.has(fn)) {
    const r = await pool.query(
      `select p.proretset as retset, t.typtype = 'c' or p.proretset as rows
         from pg_proc p join pg_type t on t.oid = p.prorettype
        where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
      [fn]
    );
    if (r.rowCount !== 1) return null;
    meta.set(fn, r.rows[0]);
  }
  return meta.get(fn);
}

async function execute(fn, args) {
  const shape = await functionShape(fn);
  if (!shape) return { status: 404, body: { code: 'PGRST202', message: `no function ${fn}` } };
  const names = Object.keys(args);
  if (!names.every((n) => IDENT.test(n))) return { status: 400, body: { message: 'bad argument name' } };
  const values = names.map((n) =>
    args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]
  );
  const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
  const sql = shape.rows
    ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from ${call} r`
    : `select to_jsonb(${call}) as v`;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const r = await client.query(sql, values);
    await client.query('commit');
    return { status: 200, body: r.rows[0].v };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    return {
      status: 400,
      body: { code: e.code ?? null, message: e.message, details: e.detail ?? null, hint: e.hint ?? null },
    };
  } finally {
    client.release();
  }
}

function reply(res, out) {
  if (res.writableEnded || res.destroyed) return false;
  res.writeHead(out.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out.body));
  return true;
}

async function deliver(job, late) {
  const started = Date.now();
  const out = await execute(job.fn, job.args);
  const answered = reply(job.res, out);
  log({ ev: 'rpc', fn: job.fn, args: job.args, receivedAt: job.receivedAt, deliveredAt: started,
        late, callerStillWaiting: answered, status: out.status, body: out.body });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__fault') {
      const next = JSON.parse(text || '{}').mode;
      if (next === 'heal') {
        const queue = held.splice(0);
        log({ ev: 'heal', delivering: queue.length });
        mode = 'ok';
        for (const job of queue) await deliver(job, true);
      } else {
        mode = next;
        log({ ev: 'mode', mode });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ mode, held: held.length }));
      return;
    }
    const m = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (req.method !== 'POST' || !m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST125', message: `not served here: ${req.method} ${url.pathname}` }));
      return;
    }
    const job = { fn: m[1], args: text ? JSON.parse(text) : {}, res, receivedAt: Date.now() };
    if (mode === 'hold') {
      held.push(job);
      log({ ev: 'held', fn: job.fn, args: job.args });
      return;
    }
    await deliver(job, false);
  });
});
server.listen(port, '127.0.0.1', () => log({ ev: 'listening', port }));
