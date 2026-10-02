/**
 * A LIFETIME TOTAL IS NOT A LOCK ON THE CLUB ROW.
 *
 * `atomic_distribute_rake` ended its standalone/private branch with
 *
 *     UPDATE public.clubs SET total_rake = COALESCE(total_rake,0) + p_rake
 *
 * once per raked hand. It is called near the START of the hand projection, so
 * that row stayed exclusively locked for everything that follows: the BBJ,
 * promo, insurance and add-on obligations, the completion stamp, the whole
 * stats projection, the outbox DELETE, and a PostgREST round trip before
 * COMMIT. pg_stat_statements put that tail at 119 ms mean, 7.9 buffers
 * dirtied, 25 kB of WAL and 8.25 full page images per call.
 *
 * Measured on production 2026-09-29 03:34-03:53 UTC, over a 45 s and a 75 s
 * sample of pg_stat_activity and pg_locks (350 and 687 samples): every backend
 * caught in Lock/transactionid held a tuple lock, and those tuples were
 * public.clubs and public.club_wallets - clubs page 46 tuple 4 in 117
 * observations, page 48 tuple 1 in 74, page 35 tuple 2 in 42. 33 wait episodes
 * in the first window, mean 127 ms, max 814 ms. The engine logged 68
 * HandProjection timeouts in ten minutes. public.clubs had taken 123,272
 * UPDATEs against ten live rows, leaving 95 percent dead tuples in 756 pages,
 * and it carries fifteen triggers that fire on UPDATE, so each counter bump
 * also ran every lifecycle and treasury guard, the settings audit, the
 * autoledger and four management event emitters.
 *
 * The write bought nothing. Nothing reads clubs.total_rake - not one of the 21
 * SQL functions that mention both names, not the two views that mention
 * total_rake (they read it from hand_history and tournaments), and no page.
 * It had already stopped being true, because only the standalone branch wrote
 * it: SHARK CLUB and Midway Union read 0.00 while their wallets held
 * 1,523,835.54 and 3,710,512.50.
 *
 * Every pin below is one of those facts:
 *
 *  1. The rake path does not write the club settings row.
 *  2. The figure it counted is still receipted and still totalled, in the same
 *     transaction, by rake_records and club_wallets.lifetime_rake_collected.
 *  3. Nothing is backfilled and nothing is repaired (10.12). The column keeps
 *     what it holds; it only stops being written.
 *  4. The migration pins the function body it produced, so a later edit that
 *     puts the write back cannot land quietly.
 *  5. It carries its own REVOKEs, because a migration is self-contained.
 *  6. What is NOT fixed is named: club_wallets is still one row per club and
 *     is still held to COMMIT. It is authoritative and read by the rakeback
 *     close, so it is a separate, money-reviewed change.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const read = (needle: string) => {
  const f = files.find((x) => x.includes(needle));
  if (!f) throw new Error(`no migration matching ${needle}`);
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};
/** Strip whole-line SQL comments: this migration quotes the statement it removed. */
const code = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

describe('a lifetime total is not a lock on the club row', () => {
  const sql = read('a_lifetime_total_is_not_a_lock_on_the_club_row');
  const body = code(sql);

  it('the rake path does not write the club settings row', () => {
    expect(body).not.toMatch(/UPDATE\s+public\.clubs/i);
    expect(body).not.toMatch(/\btotal_rake\b\s*=/);
  });

  it('replaces the whole function, so the removal cannot be partial', () => {
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.atomic_distribute_rake');
  });

  it('still receipts the rake and still totals it in the same transaction', () => {
    expect(body).toContain('INSERT INTO public.rake_records');
    expect(body).toMatch(/lifetime_rake_collected\s*=\s*lifetime_rake_collected\s*\+\s*p_rake/);
  });

  it('leaves the union rake treasury alone: that one is money', () => {
    expect(body).toMatch(
      /total_rake_collected\s*=\s*COALESCE\(public\.union_wallets\.total_rake_collected,\s*0\)\s*\+\s*p_rake/
    );
  });

  it('backfills nothing and repairs nothing', () => {
    expect(body).not.toMatch(/cron\.schedule/i);
    expect(body).not.toMatch(/\b(backfill|back_pay|backpay|repair|redrive|catchup|resweep)\b/i);
    expect(body).not.toMatch(/UPDATE\s+public\.clubs\s+SET\s+total_rake\s*=\s*\(/i);
  });

  it('pins the body it produced, so putting the write back cannot land quietly', () => {
    expect(body).toContain('RAKE_POSTIMAGE_DRIFT');
    expect(body).toMatch(/md5\(p\.prosrc\) = '[0-9a-f]{32}'/);
    expect(body).toContain('RAKE_STILL_WRITES_THE_CLUB_ROW');
    // The guard must be newline-sensitive, or it only ever reads line one.
    expect(body).toContain("'(?n)^[[:space:]]*UPDATE[[:space:]]+public\\.clubs'");
  });

  it('is self-contained: it carries its own REVOKEs', () => {
    expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.atomic_distribute_rake[^\n]*FROM PUBLIC;/);
    expect(body).toMatch(/REVOKE ALL ON FUNCTION public\.atomic_distribute_rake[^\n]*FROM anon;/);
    expect(body).toMatch(
      /REVOKE ALL ON FUNCTION public\.atomic_distribute_rake[^\n]*FROM authenticated;/
    );
    expect(body).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.atomic_distribute_rake[^\n]*TO service_role;/
    );
  });

  it('says out loud what is still held, so this does not read as a clean sheet', () => {
    const harness = readFileSync(
      join(__dirname, '..', 'scripts', 'ci', 'test-rake-does-not-lock-the-club-row.py'),
      'utf8'
    );
    expect(harness).toContain('club-wallets-is-still-held-in-both-arms');
    expect(harness).toContain('before-an-open-projection-holds-the-club-row');
    expect(harness).toContain('after-an-open-projection-holds-nothing-on-clubs');
  });
});
