# 2026-08-30 — #1498: the flows that believed they were notifying people

`pushNotificationService.sendToUser()` relayed to a Supabase edge function that
relayed to OneSignal. OneSignal was retired on 2026-08-19, so from that day
every call delivered nothing, returned `false`, and was never checked by its
caller. Eight call sites.

It cannot be fixed on the client, by design: `notifications` has RLS on with a
single INSERT policy (`service_role` only) and `push_outbox` grants the browser
nothing. The old edge function did no authorisation at all, so pointing it at a
live transport would have turned a dead relay into a spam vector.

The working path already existed:

```
INSERT INTO notifications
  -> trg_mirror_notification_to_push_outbox
  -> push_outbox
  -> /api/cron/push-dispatch   (every minute, applies the consent gate)
```

## What was actually missing — and what wasn't

I assumed all eight flows were dark. Two rounds of probing said otherwise.

**Cash-outs were never broken.** `pushQuietly` in `CashoutService.ts` carried
the comment "the in-app notification the RPC already wrote inside the money
transaction", and the catalogue confirmed it: `fn_cashout_approve`,
`fn_cashout_release`, `fn_cashout_request` and `fn_expire_stale_cashouts` all
write `notifications` rows inside the money transaction, and the mirror trigger
turns each into a push. `tr_notify_agent_on_cashout` has been telling the agent
about new requests all along. The client call was a redundant _second_ push over
the same event; OneSignal's retirement only made the redundancy invisible.

My first migration added a cash-out trigger anyway. It emitted
`cashout_approved` and `cashout_cancelled` — the exact strings the RPCs already
emit — so on the real paths every player would have been told twice that their
money moved. Dropped in
`20260830_drop_redundant_cashout_notify_trigger.sql`.

**Disputes and credit requests genuinely had nothing.** No RPC, no trigger, no
server-side notification of any kind. Those are the real gap and they are now
closed by triggers on the state change itself, which is strictly better than the
client call they replace: a Commander approving from the staff UI, an admin RPC
or a back-office script all notify identically.

| flow                        | before         | now                                       |
| --------------------------- | -------------- | ----------------------------------------- |
| dispute filed → club owner  | nothing        | `trg_notify_dispute` on INSERT            |
| dispute resolved → filer    | nothing        | `trg_notify_dispute` on status → resolved |
| credit requested → approver | nothing        | `trg_notify_credit_request` on INSERT     |
| credit approved → requester | nothing        | on status → approved                      |
| credit denied → requester   | nothing        | on status → denied                        |
| every cash-out transition   | already worked | unchanged, client duplicate removed       |

All three tables were empty when this shipped (disputes 0, credit_requests 0,
cashout_requests 0), so nothing needed backfilling and nobody had been harmed
yet — these features will notify correctly the first time they are ever used.

## How it was tested

Every probe ran inside a transaction that was rolled back (CLAUDE.md 11.5 —
never spend real chips to test a rule). Verified afterwards: 0 rows in all three
tables, 0 notifications, 0 outbox rows.

The final probe drives insert plus every status transition and asserts one
notification and one outbox row per event:

```
cashout_request           1 raised, 1 outbox   (pre-existing, agent)
settlement_dispute_filed  1 raised, 1 outbox
dispute_resolved          1 raised, 1 outbox
credit_request            1 raised, 1 outbox
credit_approved           1 raised, 1 outbox
```

`under_review`, `completing` and `cancelling` correctly stay silent.

## Safety

Every trigger body is wrapped in its own `BEGIN/EXCEPTION` that swallows and
`RAISE WARNING`s. A failure to tell somebody about their cash-out must never be
able to un-cash-out them.

## The consent gate (World Hub, same change)

`eventToTypeKey` returns null for an unknown event, and null means "allow it".
That silently forfeits the user's toggle — the bug that let `waitlist_seat_open`
run ungated across 95% of all outbox traffic. So the World Hub PR registers
every one of these events under a new `cashier` push type ("Cashier and Credit"),
including the five pre-existing cash-out events that were themselves
unregistered until now.
