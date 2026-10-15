#!/usr/bin/env node
// Owner-dispatched drain of the horse adaptive retention backlog.
//
// It calls the installed, bounded owner public.fn_prune_horse_adaptive_journal()
// repeatedly, one committed statement per call, and nothing else. Every rule
// (protection, certificates, compaction, statistics, capacity lock, budgets)
// lives in that function; this script adds no SQL logic, writes no money and
// retries nothing it cannot read. It stops by itself when fewer than
// STOP_BELOW hands remain pending or when MAX_MINUTES elapse, whichever is
// first. It is dispatched by a person only: no schedule, no push trigger.
//
// Exit 0: cleared, or the time cap was reached (dispatch again to continue).
// Exit 1: refused before any call (configuration). Exit 3: a call failed in a
// way this script cannot classify; inspect before dispatching again.
//
// It shares the owner's capacity lock with the engine's journal writes and
// yields it (see horse-adaptive-drain-yield.mjs): no call while journal work
// is ready, and after each call a pause at least as long as the call.
import { readFileSync, appendFileSync } from 'node:fs';
import {
  DRAIN_READY_WORK_WAIT_MS,
  READY_WORK_SQL,
  pauseAfterCallMs,
} from './horse-adaptive-drain-yield.mjs';

const CONN = process.env.DATABASE_URL;
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 340);
const STOP_BELOW = Number(process.env.STOP_BELOW || 2000);
const SSL_ROOT = process.env.PGSSLROOTCERT || 'scripts/ci/certificates/supabase-prod-ca-2021.crt';

function finish(code, line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  process.exit(code);
}
if (!CONN) finish(1, '[drain] REFUSED: DATABASE_URL is not configured');
if (!Number.isInteger(MAX_MINUTES) || MAX_MINUTES < 1 || MAX_MINUTES > 345)
  finish(1, '[drain] REFUSED: max_minutes must be an integer from 1 to 345');
if (!Number.isInteger(STOP_BELOW) || STOP_BELOW < 1 || STOP_BELOW > 100000)
  finish(1, '[drain] REFUSED: stop_below must be an integer from 1 to 100000');

let url;
try { url = new URL(CONN); } catch { finish(1, '[drain] REFUSED: database connection syntax is invalid'); }
if (!['postgres:', 'postgresql:'].includes(url.protocol)) finish(1, '[drain] REFUSED: database protocol is invalid');
for (const key of ['sslmode', 'ssl', 'sslrootcert']) url.searchParams.delete(key);
let ca;
try { ca = readFileSync(SSL_ROOT, 'utf8'); } catch { finish(1, '[drain] REFUSED: provider CA certificate is unavailable'); }

const { default: pg } = await import('pg');
const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { rejectUnauthorized: true, ca },
  application_name: 'horse-adaptive-retention-drain',
});
client.on('error', (e) => finish(3, `[drain] UNKNOWN: database transport disconnected (${e.code || e.message})`));
await client.connect();
await client.query("SET statement_timeout = '60s'");

const pendingBelowStop = async () => {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM (SELECT 1 FROM smarter_private.horse_adaptive_disposal_certificates
      WHERE retired_at IS NULL OR raw_format_version < 2 LIMIT $1) x`, [STOP_BELOW]);
  return rows[0].n < STOP_BELOW;
};

const started = Date.now();
const deadline = started + MAX_MINUTES * 60_000;
const totals = {
  calls: 0, busy: 0, retiredHands: 0, observations: 0, statisticsExpired: 0, lockTimeouts: 0,
  yieldedToWork: 0,
};
let outcome = 'time cap reached; dispatch again to continue';
let consecutiveLockTimeouts = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (Date.now() < deadline) {
  // The engine's journal writes only try the capacity lock. Never take it
  // while one of them is due.
  const { rows: ready } = await client.query(READY_WORK_SQL);
  if (ready[0].ready) {
    totals.yieldedToWork++;
    await sleep(DRAIN_READY_WORK_WAIT_MS);
    continue;
  }
  let receipt;
  const callStarted = Date.now();
  try {
    const { rows } = await client.query('SELECT public.fn_prune_horse_adaptive_journal() AS r');
    receipt = rows[0].r;
    consecutiveLockTimeouts = 0;
    // Stay off the lock at least as long as the call held it.
    await sleep(pauseAfterCallMs(Date.now() - callStarted));
  } catch (e) {
    // The owner's own lock_timeout (2 s) refuses and rolls back the call; that
    // is a known, harmless outcome. Anything else is unclassified: stop.
    if (e.code === '55P03' && ++consecutiveLockTimeouts <= 20) {
      totals.lockTimeouts++;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    await client.end().catch(() => {});
    finish(3, `[drain] UNKNOWN: call failed (${e.code || 'no code'}: ${e.message}); totals ${JSON.stringify(totals)}`);
  }
  totals.calls++;
  if (receipt?.status === 'unavailable') {
    totals.busy++;
    await new Promise((r) => setTimeout(r, 300));
  } else if (receipt?.status === 'pruned') {
    totals.retiredHands += receipt.retiredHands;
    totals.observations += receipt.observations;
    totals.statisticsExpired += receipt.statisticsExpired;
  } else {
    await client.end().catch(() => {});
    finish(3, `[drain] UNKNOWN: unexpected receipt ${JSON.stringify(receipt)}`);
  }
  if (totals.calls % 100 === 0) {
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(`[drain] ${minutes} min ${JSON.stringify(totals)}`);
    if (await pendingBelowStop()) { outcome = `cleared: fewer than ${STOP_BELOW} hands pending`; break; }
  }
}
await client.end().catch(() => {});
finish(0, `[drain] DONE (${outcome}) after ${((Date.now() - started) / 60_000).toFixed(1)} min: ${JSON.stringify(totals)}`);
