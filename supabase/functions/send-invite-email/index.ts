/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEND INVITE EMAIL - REFUSES EVERYTHING
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS USED TO BE, AND WHY IT COULD NOT STAY
 *
 * An open mail relay from the platform's own verified sending domain. It read
 * `to`, `clubName`, `inviterName`, `inviteUrl` and `inviteCode` straight from
 * the request body, interpolated all five into an HTML body WITHOUT ESCAPING
 * ANY OF THEM, and sent it through Resend as
 * `Club Arena <invites@clubarena.poker>`.
 *
 * It was deployed with `verify_jwt: true`, and that is not authorisation. The
 * anon key is published in the client bundle and is a valid JWT, so every
 * anonymous visitor passed the gate. The body performed no authorisation of any
 * kind: it never asked who the caller was, whether they belonged to the club
 * they named, or whether the recipient had ever been invited to anything.
 *
 * So: arbitrary HTML, to an arbitrary recipient, from the brand's own
 * DKIM-signed domain, carrying an attacker-chosen link under the words "Accept
 * Invitation" - aimed at a player base that is being onboarded right now. That
 * is a phishing primitive with the platform's reputation behind it, and it is
 * worse than the push relay it is modelled on, because mail from a verified
 * domain actually arrives.
 *
 * THIS SHAPE WAS ALREADY REJECTED IN THIS ESTATE
 *
 * `send-push-notification` was retired to this same refusal on 2026-08-31 for
 * the identical shape - caller-supplied audience, caller-supplied content, no
 * authorisation, `verify_jwt` mistaken for a check (issue #1498). World Hub
 * closed the identical hole in `pages/api/notifications/send.js` on 2026-07-25.
 * This is the third instance of one pattern.
 *
 * WHY IT IS A REFUSAL RATHER THAN AN AUTHORISATION CHECK
 *
 * The correct authorised version cannot be written, because the flow it served
 * does not exist. The fix would have to derive `clubName`, `inviteUrl` and
 * `inviteCode` server-side from a pending invite row - and there is no such
 * row to derive them from:
 *
 *   - `public.club_invites` DOES NOT EXIST in production. Not empty: absent.
 *   - Nothing in the repository calls this function. The only mention outside
 *     this file is a `supabase functions deploy` line in its own header.
 *   - `src/components/agent/PlayerInviteModal.tsx` already migrated off it. The
 *     dead `club_invites` write was replaced by a link that actually redeems,
 *     through `fn_redeem_club_invite_code`, which resolves `ref` to the agent,
 *     attaches the new player to their downline and admits them to the club.
 *   - Measured before this change: ZERO invocations in the preceding 24 hours.
 *
 * Building an authorisation check around a table that does not exist, for a
 * flow no caller uses, would leave a live mail relay in place to protect a
 * feature that was already replaced. Retiring it is the smaller and safer
 * change, and it is the one the precedent sets.
 *
 * WHY IT IS A REFUSAL RATHER THAN A DELETION
 *
 * The MCP surface can deploy an edge function but cannot delete one. A refusal
 * removes the capability now, without waiting on a dashboard visit, and it
 * leaves the reason where the next person looks. Deleting the function outright
 * is still the right end state and is a one-click dashboard action.
 *
 * THE PATH THAT ACTUALLY WORKS
 *
 * An agent invites a player with a redeemable link built in the client from
 * their own player number - see `PlayerInviteModal.generateInviteCode` - and
 * `fn_redeem_club_invite_code` does the admitting. No mail is sent by the
 * platform, so no mail can be forged through it.
 *
 * If club invite EMAIL is ever genuinely wanted, it is written server-side from
 * a trusted context against a real pending-invite row, with every interpolated
 * value HTML-escaped and the recipient taken from the row rather than from the
 * request. Not from a browser-reachable relay that trusts its caller.
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
        'This relay is retired. It sent caller-supplied, unescaped HTML to a ' +
        'caller-supplied recipient from invites@clubarena.poker, and it ' +
        'authorised nobody: verify_jwt passes the published anon key. The ' +
        'flow it served no longer exists - public.club_invites is absent and ' +
        'PlayerInviteModal now builds a link that redeems through ' +
        'fn_redeem_club_invite_code. Same shape as send-push-notification, ' +
        'retired 2026-08-31; see issue #1498.',
    }),
    { status: 410, headers: { ...CORS, 'Content-Type': 'application/json' } }
  );
});
