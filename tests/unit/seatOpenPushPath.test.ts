/**
 * A SEAT OFFER SENDS ONE PUSH, TO SOMEBODY WHO IS ACTUALLY WAITING.
 * ============================================================================
 * Two rules, both bought with a real regression.
 *
 * 1. ONE WRITER. This file used to POST straight to onesignal.com — a vendor
 *    removed on 2026-08-19, a week before that block was written, so it never
 *    delivered anything (no ONESIGNAL_APP_ID in the engine container, zero
 *    OneSignal lines in 48h of logs, the `if (osAppId && osKey)` guard false
 *    on every offer). The repair on 2026-08-26 added an explicit
 *    `push_outbox` insert instead. That was one writer too many:
 *    `trg_mirror_notification_to_push_outbox` — AFTER INSERT ON notifications,
 *    live since before either version — already mirrors the notification row
 *    into push_outbox. Every seat offer enqueued TWICE.
 *
 *    It was visible rather than merely wasteful, because the two rows carried
 *    different tags (`waitlist_seat_open:<id>` from the trigger,
 *    `seat-open-<tableId>` from the engine). The tag is what lets the OS
 *    collapse a repeat into the banner already on screen, so two rows with
 *    identical text and different tags are guaranteed to STACK. That is the
 *    pair of identical "A Seat Just Opened At PLO4 0.50/1.00" banners Dan
 *    photographed on 2026-08-29; the rows behind it were 7e1ba96a and
 *    91453e36, 237ms apart, both delivered to the same phone.
 *
 *    So this file writes the NOTIFICATION and nothing else. The trigger turns
 *    it into exactly one push, and push-dispatch runs gateDecision() on that
 *    row, so opt-outs are respected by construction rather than by this file
 *    remembering to check.
 *
 * 2. ONLY SOMEBODY WAITING. Dan 2026-08-29: "the seat open push notification
 *    should only occur if you are on a list waiting for a seat, not randomly."
 *    Two ways a row stopped meaning that, both fixed in the same commit:
 *    an abandoned queue row was immortal (the 24h GC in
 *    20260826151500 ran once, as a backlog cleanup, and no recurring job took
 *    it over), and taking a seat by any route other than the offer itself left
 *    the row 'waiting', so the next seat to turn over pushed "tap to claim it"
 *    to somebody already sitting at that table.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const SEATS = resolve(__dirname, '../../server/src/services/supabase/seats.ts');
const src = existsSync(SEATS) ? readFileSync(SEATS, 'utf8') : '';

describe('seat-open push', () => {
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

  it('has exactly ONE push writer — the notification row the DB trigger mirrors', () => {
    // The regression this pins is a SECOND enqueue, not a missing one. If a
    // future change needs to enqueue directly, it must first remove the
    // trigger, and this assertion is where that conversation starts.
    expect(src).not.toMatch(/from\(['"`]push_outbox['"`]\)\s*\.insert/);
    expect(src).toMatch(/from\(['"`]notifications['"`]\)\s*\.insert/);
    expect(src).toMatch(/type:\s*['"`]waitlist_seat_open['"`]/);
  });

  it('carries the table id, which is what the action-url trigger deep-links from', () => {
    // The push URL is derived by fn_notification_fill_action_url from this
    // payload. Drop it and the banner lands on /hub with no table.
    expect(src).toMatch(/data:\s*\{\s*table_id:\s*tableId\s*\}/);
  });

  it('retires a queue row older than its TTL before choosing who to offer', () => {
    expect(src).toMatch(/WAITLIST_ENTRY_TTL_MS/);
    // Applied to 'waiting' rows by created_at — an abandoned place in line,
    // as distinct from WAITLIST_OFFER_TTL_MS, which reclaims a dead offer.
    expect(src).toMatch(/\.eq\('status', 'waiting'\)[\s\S]{0,160}created_at/);
  });

  it('never offers a seat to somebody already sitting at that table', () => {
    expect(src).toMatch(/from\('table_seats'\)/);
    expect(src).toMatch(/\.is\('left_at', null\)/);
    expect(src).toMatch(/status: 'seated'/);
  });

  it('still notifies only a HUMAN at the head of the queue', () => {
    // Horses are players everywhere else (CLAUDE.md 10.5); this is the one
    // sanctioned use of the flag — a horse has no phone to push to.
    expect(src).toMatch(/is_horse/);
  });
});
