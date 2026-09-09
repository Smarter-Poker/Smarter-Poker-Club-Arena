/**
 * A SEAT OFFER SENDS ONE PUSH, TO SOMEBODY WHO IS ACTUALLY WAITING.
 * ============================================================================
 * The rules are unchanged since 2026-08-29; WHERE they live changed on
 * 2026-08-30, and this file moved with them. Both halves are asserted, because
 * either one going missing re-opens a report Dan raised.
 *
 * 1. ONE PUSH WRITER. This path used to POST straight to onesignal.com — a
 *    vendor removed on 2026-08-19, a week before that block was written, so it
 *    never delivered anything. The 2026-08-26 repair added an explicit
 *    `push_outbox` insert instead, which was one writer too many:
 *    `trg_mirror_notification_to_push_outbox` already mirrors the notification
 *    row into push_outbox. Every offer enqueued TWICE, and visibly, because the
 *    two rows carried different tags — and the tag is what lets the OS collapse
 *    a repeat into the banner already on screen. That is the pair of identical
 *    "A Seat Just Opened At PLO4 0.50/1.00" banners Dan photographed; the rows
 *    behind it were 7e1ba96a and 91453e36, 237ms apart, both delivered.
 *
 * 2. ONLY SOMEBODY WAITING. Dan 2026-08-29: "the seat open push notification
 *    should only occur if you are on a list waiting for a seat, not randomly."
 *    An abandoned queue row was immortal (the 24h GC in 20260826151500 ran
 *    once, as a backlog cleanup, and no recurring job took it over), and taking
 *    a seat by any route other than the offer itself left the row 'waiting', so
 *    the next seat to turn over pushed "tap to claim it" at somebody already
 *    sitting at that table.
 *
 * WHY THE ASSERTIONS NOW POINT AT SQL. On 2026-08-30 the whole sequence became
 * `fn_offer_open_seat`, one transaction, for a correctness reason rather than a
 * tidiness one: between reading the queue head and claiming it, a concurrent
 * opener could take the same row, and the loser's seat went UNOFFERED in
 * silence. `FOR UPDATE ... SKIP LOCKED` hands a concurrent caller the next
 * person in line instead of a collision. So the TypeScript is asserted to be a
 * thin, single call, and the rules are asserted against the migration that now
 * holds them.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SEATS = resolve(__dirname, '../../server/src/services/supabase/seats.ts');
const src = existsSync(SEATS) ? readFileSync(SEATS, 'utf8') : '';

/* The migration is found by NAME rather than by a hard-coded path so that a
   later migration which supersedes it fails this test loudly instead of
   leaving it passing against a file nothing runs any more. */
const MIGRATIONS = resolve(__dirname, '../../supabase/migrations');
const offerMigration = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).find((f) => f.includes('offer_open_seat'))
  : undefined;
const sql = offerMigration ? readFileSync(join(MIGRATIONS, offerMigration), 'utf8') : '';

describe('seat-open push — the engine side', () => {
  it('the source is present', () => {
    expect(src).not.toBe('');
  });

  it('never calls OneSignal — the vendor was removed on 2026-08-19', () => {
    expect(src).not.toMatch(/fetch\(\s*['"`]https:\/\/onesignal\.com/);
    expect(src).not.toMatch(/include_external_user_ids/);
  });

  it('does not depend on OneSignal credentials to decide whether to send', () => {
    // The old guard silently skipped the whole block when these were unset,
    // which is why nobody noticed for a month.
    expect(src).not.toMatch(/if\s*\(\s*osAppId\s*&&\s*osKey/);
  });

  it('writes NO push of its own — the notification the RPC inserts is the only one', () => {
    // The regression this pins is a SECOND enqueue, not a missing one.
    expect(src).not.toMatch(/from\(['"`]push_outbox['"`]\)\s*\.insert/);
    expect(src).not.toMatch(/from\(['"`]notifications['"`]\)\s*\.insert/);
  });

  it('is one RPC call, not a sequence the caller can get half-right', () => {
    expect(src).toMatch(/supabase\.rpc\(['"`]fn_offer_open_seat['"`]/);
    expect(src).toMatch(/p_table_id: tableId/);
    // No queue reading left in TypeScript: that is what raced.
    expect(src).not.toMatch(/from\(['"`]table_waitlist['"`]\)/);
  });

  it('never throws out of the offer path — a failed offer must not stall a table', () => {
    const fn = src.slice(src.indexOf('export async function notifyWaitlistSeatOpen'));
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch/);
    // An RPC error is reported and swallowed, never rethrown into the caller,
    // which is a cash-out path.
    expect(fn).toMatch(/if \(error\)/);
  });

  it('offers the seat through atomicCashout and pending processing, including the delegated leave', () => {
    const delegated = src.slice(
      src.indexOf('export async function markSeatAsLeft('),
      src.indexOf('export async function atomicCashout(')
    );
    expect(delegated).toMatch(/await atomicCashout\(/);
    const cashout = src.slice(
      src.indexOf('export async function atomicCashout('),
      src.indexOf('export async function notifyWaitlistSeatOpen(')
    );
    expect(cashout).toContain('void notifyWaitlistSeatOpen(tableId)');
    const pending = src.slice(src.indexOf('export async function processLeavePending('));
    expect(pending).toContain('void notifyWaitlistSeatOpen(tableId)');
  });
});

describe('seat-open push — the rules, now in the migration', () => {
  it('the migration is present and is the one that defines the RPC', () => {
    expect(offerMigration, 'no offer_open_seat migration found').toBeTruthy();
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fn_offer_open_seat/);
  });

  it('retires a lapsed OFFER and tells the player, instead of dropping them in silence', () => {
    expect(sql).toMatch(/p_offer_ttl interval DEFAULT interval '3 minutes'/);
    expect(sql).toMatch(/notified_at < now\(\) - p_offer_ttl/);
    expect(sql).toMatch(/'waitlist_offer_expired'/);
    // A bell item, never an interrupt: '_push' is the documented signal that
    // makes the mirror trigger skip the row.
    expect(sql).toMatch(/'_push', 'skip'/);
  });

  it('retires an ABANDONED place in line', () => {
    expect(sql).toMatch(/p_entry_ttl interval DEFAULT interval '24 hours'/);
    expect(sql).toMatch(/created_at < now\(\) - p_entry_ttl/);
  });

  it('never offers a seat to somebody already sitting at that table', () => {
    expect(sql).toMatch(/FROM public\.table_seats s/);
    expect(sql).toMatch(/s\.left_at IS NULL/);
    expect(sql).toMatch(/SET status = 'seated'/);
  });

  it('claims the queue head under a lock, so a concurrent opener cannot burn the seat', () => {
    expect(sql).toMatch(/FOR UPDATE OF w SKIP LOCKED/);
    expect(sql).toMatch(/ORDER BY w\.created_at/);
    // No ceiling on how far down the queue it will look. The old TypeScript
    // read the ten oldest rows and gave up if all ten were horses.
    expect(sql).not.toMatch(/LIMIT 10\b/);
  });

  it('offers to a HUMAN — the one sanctioned use of is_horse here', () => {
    // Horses are players everywhere else (CLAUDE.md 10.5). A horse has no
    // phone, so offering it the seat wastes the offer while people wait.
    expect(sql).toMatch(/NOT COALESCE\(p\.is_horse, false\)/);
  });

  it('writes exactly one notification for the offer, and lets the trigger push it', () => {
    expect((sql.match(/'waitlist_seat_open'/g) || []).length).toBe(1);
    expect(sql).toMatch(/jsonb_build_object\('table_id', p_table_id\)/);
    expect(sql).not.toMatch(/INSERT INTO public\.push_outbox/);
  });

  it('is not callable from a browser', () => {
    // A mutating SECURITY DEFINER function reachable by anon or authenticated
    // is a seat-offer forgery primitive.
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.fn_offer_open_seat[\s\S]*FROM anon/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_offer_open_seat[\s\S]*FROM authenticated/
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_offer_open_seat[\s\S]*TO service_role/
    );
  });
});
