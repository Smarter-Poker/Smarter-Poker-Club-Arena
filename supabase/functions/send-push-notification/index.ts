/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEND PUSH NOTIFICATION - REFUSES EVERYTHING (issue #1498, closed 2026-08-31)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS USED TO BE, AND WHY IT COULD NOT STAY
 *
 * A relay to OneSignal that performed NO AUTHORISATION OF ANY KIND. It read
 * `userIds`, `title`, `message` and `url` straight from the request body and
 * pushed them, and it is deployed with `verify_jwt: true` - so ANY signed-in
 * player could push arbitrary text, to arbitrary people, carrying an arbitrary
 * link. That is a spam and phishing primitive, and the only reason it was not
 * one in practice is that OneSignal was removed from the platform on
 * 2026-08-19 and the vendor behind it stopped answering.
 *
 * "Inert because the vendor is gone" is not a security control. Anyone who
 * later repointed this at a working transport - which is exactly what a person
 * fixing "push is broken" would do - would have converted a dead relay into a
 * live one, with no authorisation anywhere in the path. World Hub closed the
 * identical hole in pages/api/notifications/send.js on 2026-07-25.
 *
 * WHY IT IS A REFUSAL RATHER THAN A DELETION
 *
 * The MCP surface can deploy a function but cannot delete one. A refusal
 * removes the capability now, today, without waiting on a dashboard visit, and
 * it leaves the reason where the next person looks. Deleting the function
 * outright is still the right end state and is a one-click dashboard action.
 *
 * THE PATH THAT ACTUALLY WORKS
 *
 * Push is written server-side, into `notifications`. The trigger
 * `trg_mirror_notification_to_push_outbox` mirrors that row into `push_outbox`,
 * and World Hub's /api/cron/push-dispatch drains the queue applying the consent
 * gate to every row - so a push written that way respects opt-outs by
 * construction, and cannot be aimed by whoever happens to be holding a JWT.
 * See server/src/services/supabase/seats.ts for a live example.
 *
 * Measured before this change: ZERO invocations in the preceding 24 hours.
 * Nothing calls it. Nothing has called it since the eight client call sites
 * were removed.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type',
};

serve((req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS });
  }

  return new Response(
    JSON.stringify({
      error: 'gone',
      message:
        'This relay is retired. It pushed to OneSignal, which was removed on ' +
        '2026-08-19, and it authorised nobody. Write the notification ' +
        'server-side instead: insert into public.notifications, which mirrors ' +
        'to push_outbox and is drained by /api/cron/push-dispatch with the ' +
        'consent gate applied. See issue #1498.',
    }),
    { status: 410, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
