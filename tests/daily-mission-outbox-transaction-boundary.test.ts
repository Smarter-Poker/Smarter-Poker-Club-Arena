import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const migration = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260908233129_daily_mission_users_do_not_share_one_long_transaction.sql'
  ),
  'utf8'
);
const probe = readFileSync(
  resolve(root, 'scripts/dev/probe-daily-mission-outbox-transaction-boundary-pg17.sh'),
  'utf8'
);

function section(start: string, end: string) {
  const from = migration.indexOf(start);
  const to = migration.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return migration.slice(from, to);
}

describe('Daily Missions outbox transaction boundary', () => {
  it('makes every compatibility call structurally one-player-only', () => {
    const wrapper = section(
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox(',
      'COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox(integer, integer, integer)'
    );
    expect(wrapper).toContain('LIMIT 1');
    expect(wrapper).toContain('fn_drain_daily_challenge_event_outbox_user(');
    expect(wrapper).not.toContain('FOR r IN');
  });

  it('keeps same-player locking, event order, receipts, and contention evidence', () => {
    const body = section(
      'CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox_user(',
      'COMMENT ON FUNCTION public.fn_drain_daily_challenge_event_outbox_user(uuid, integer)'
    );
    expect(body.indexOf('fn_lock_daily_mission_user')).toBeLessThan(body.indexOf('FOR r IN'));
    expect(body).toContain('ORDER BY o.created_at, o.event_key');
    expect(body).toContain('public.enqueue_daily_challenge_event(');
    expect(body).toContain('SET attempts = o.attempts + 1');
    expect(body).toContain('v_done := 0;');
    expect(body).toContain("THEN '3s' ELSE '250ms'");
    expect(body).toContain("interval '35 days'");
  });

  it('uses a postgres-only top-level procedure with a real commit per player', () => {
    const procedure = section(
      'CREATE OR REPLACE PROCEDURE public.sp_drain_daily_challenge_event_outbox(',
      'ALTER PROCEDURE public.sp_drain_daily_challenge_event_outbox'
    );
    expect(procedure).toContain('COMMIT AND CHAIN;');
    expect(procedure).toContain('c_user_batch constant integer := 100');
    expect(procedure).not.toContain('SECURITY DEFINER');
    expect(procedure).not.toMatch(/\nSET search_path/);
    expect(migration).toContain(
      'REVOKE ALL ON PROCEDURE public.sp_drain_daily_challenge_event_outbox(integer, integer, integer)'
    );
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('wires all four existing primary shards to top-level CALL', () => {
    expect(
      migration.match(/CALL public\.sp_drain_daily_challenge_event_outbox\(5000, [0-3], 4\);/g)
    ).toHaveLength(4);
    expect(migration).not.toContain('SELECT public.fn_drain_daily_challenge_event_outbox(5000');
  });

  it('ships a PostgreSQL 17 two-session foreign-key lock regression', () => {
    expect(probe).toContain('CALL public.sp_drain_daily_challenge_event_outbox(20, 0, 1);');
    expect(probe).toContain("VALUES ('11111111-0000-4000-8000-000000000001')");
    expect(probe).toContain("VALUES ('22222222-0000-4000-8000-000000000002')");
    expect(probe).toContain("SET lock_timeout = '400ms'");
    expect(probe).toContain('each event must have exactly one durable receipt');
    expect(probe).toContain('rolled-back player batch reported false telemetry');
    expect(probe).toContain("'probe:rollback-second'");
  });
});
