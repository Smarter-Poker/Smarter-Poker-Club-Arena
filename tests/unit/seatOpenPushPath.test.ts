/**
 * THE SEAT-OPEN PUSH MUST NOT GO TO A VENDOR WE NO LONGER USE.
 * ============================================================================
 * OneSignal was removed from this platform on 2026-08-19 and replaced with
 * self-hosted VAPID web push. `pages/api/notifications/send.js` in World Hub
 * says so in its header and rejects OneSignal device ids outright.
 *
 * The seat-open push in server/src/services/supabase/seats.ts was written on
 * 2026-08-26 — a week AFTER that — and POSTed straight to
 * onesignal.com/api/v1/notifications. It never delivered anything:
 *
 *   - the engine container has no ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY
 *     (verified 2026-08-27 inside club-arena-engine: `printenv | grep -c` = 0);
 *   - 48h of its logs contained zero OneSignal lines;
 *   - so the `if (osAppId && osKey)` guard was false on every seat offer and
 *     the whole block was skipped in silence.
 *
 * It now writes a `push_outbox` row, which World Hub's /api/cron/push-dispatch
 * drains. That cron calls gateDecision() on every row before delivering, so
 * this path respects opt-outs BY CONSTRUCTION rather than by this file
 * remembering to check — which also closes the consent bypass the old raw
 * insert had (send.js enforces preferences; the engine went around it).
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

  it('enqueues to push_outbox, the queue push-dispatch actually drains', () => {
    expect(src).toMatch(/from\(['"`]push_outbox['"`]\)\s*\.insert/);
  });

  it('targets the recipient and carries an event the consent gate can read', () => {
    expect(src).toMatch(/recipient_user_id/);
    expect(src).toMatch(/event:\s*['"`]waitlist_seat_open['"`]/);
  });

  it('sends a same-origin path, not an absolute smarter.poker URL', () => {
    // An absolute URL breaks the moment this runs against a preview origin.
    expect(src).toMatch(/url:\s*[`'"]\/hub\/club-arena\/table\//);
  });

  it('never throws out of the push path — a seat offer must still be recorded', () => {
    const block = src.slice(src.indexOf('push_outbox'));
    expect(block).toMatch(/catch/);
  });
});
