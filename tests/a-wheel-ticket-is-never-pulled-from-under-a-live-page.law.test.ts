/**
 * A wheel ticket is never pulled from under a live page (2026-09-22).
 *
 * WHY THIS EXISTS
 *
 * fn_wheel_commit began by deleting every unconsumed wheel ticket the player
 * held before it dealt a new one. The wheel page deals itself a ticket when it
 * loads and after every spin, so a second page of the same player - another
 * tab, or a refresh during the maintenance break - destroyed the ticket the
 * first page was holding, and the first page's spin was refused with "That
 * Spin Ticket Is Not Yours Or Was Already Used. Open The Wheel Again". The
 * Diamond Games had the same defect until migration 20260921185541
 * (tests/a-saved-round-settles-itself.law.test.ts).
 *
 * Migration 20260922032153 makes fn_wheel_commit sweep only the player's
 * EXPIRED unconsumed tickets. Every spin path looks up the ticket it was
 * passed (owner, unconsumed, unexpired) before any money moves, and nobody
 * knows the seed behind a live ticket, so holding several gives no edge.
 *
 * This law pins:
 *  1. the installed migration replaces fn_wheel_commit with the expired-only
 *     sweep and no other ticket delete;
 *  2. it is one transaction with bounded lock and statement time, and checks
 *     the definition it was measured against before replacing it;
 *  3. no later migration reinstates the live-ticket sweep, and every later
 *     DELETE from wheel_seed_commits, however it is spelled, sweeps only
 *     expired tickets.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const DIR = 'supabase/migrations';
const FILE = '20260922032153_a_wheel_ticket_is_never_pulled_from_under_a_live_page.sql';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** SQL without comments: a header may describe the old sweep, the code may not run it. */
const code = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** The statement that pulled a live ticket from under another page. */
const LIVE_TICKET_SWEEP =
  'DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL;';
/** The statement that replaced it. */
const EXPIRED_ONLY_SWEEP =
  'DELETE FROM public.wheel_seed_commits WHERE user_id = v_user AND consumed_by IS NULL AND expires_at < now();';
/** Every DELETE aimed at the wheel's ticket table, however it is spelled. */
const TICKET_DELETES = /delete\s+from\s+(?:public\s*\.\s*)?"?wheel_seed_commits"?\b[^;]*;/gi;
const SWEEPS_ONLY_EXPIRED = /expires_at\s*<\s*now\s*\(\s*\)/i;

const laterMigrations = () =>
  readdirSync(join(ROOT, DIR))
    .filter((f) => f.endsWith('.sql') && f > FILE)
    .sort()
    .map((f) => ({ file: f, sql: read(`${DIR}/${f}`) }));

describe('a wheel ticket is never pulled from under a live page', () => {
  it('dealing a ticket sweeps only the player expired, never-used tickets', () => {
    const sql = read(`${DIR}/${FILE}`);
    const body = code(sql);
    const from = body.indexOf('CREATE OR REPLACE FUNCTION public.fn_wheel_commit()');
    expect(from, 'the migration replaces fn_wheel_commit').toBeGreaterThan(-1);
    expect(body.slice(from)).toContain(EXPIRED_ONLY_SWEEP);
    expect(sql).not.toContain(LIVE_TICKET_SWEEP);
    const deletes = [...body.matchAll(TICKET_DELETES)].map((m) => m[0]);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toMatch(SWEEPS_ONLY_EXPIRED);
  });

  it('is one bounded transaction that checks its preimage before replacing it', () => {
    const body = code(read(`${DIR}/${FILE}`));
    expect(body.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(body.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(body).toContain("SET LOCAL lock_timeout = '2s';");
    expect(body).toContain("SET LOCAL statement_timeout = '20s';");
    const guard = body.indexOf("('fn_wheel_commit()','34c775fe864cc754f30793582aa162ad')");
    expect(guard, 'the measured fn_wheel_commit preimage is asserted').toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('CREATE OR REPLACE FUNCTION public.fn_wheel_commit()'));
    expect(body).toContain("RAISE EXCEPTION 'Wheel Ticket Preimage Changed: %'");
  });

  it('no later migration reinstates the live-ticket sweep', () => {
    for (const { file, sql } of laterMigrations()) {
      const body = code(sql);
      expect(body, file).not.toContain(LIVE_TICKET_SWEEP);
      for (const m of body.matchAll(TICKET_DELETES)) {
        expect(m[0], `${file} may sweep only expired wheel tickets`).toMatch(SWEEPS_ONLY_EXPIRED);
      }
    }
  });
});
