# Member record and roster signals use the existing private engine socket

The two source signals account for nearly all measured database Broadcast sends.
The client previously always joined paid Supabase Broadcast topics, although
`/ws/channel` already carries private engine events. The existing LISTEN factory
only reads an environment URL; the heartbeat's already maintained Vault resolver
holds the supported least-privileged session URL in memory.

This compatible bridge adds only member-record and club-roster topics. A dedicated
LISTEN socket resolves that existing URL, uses verified TLS and receives minimal
`{topic,event}` notifications on `ca_private_record_changes`. It never shares a
heartbeat connection, changes privileges, polls data, or reads financial rows.
The source readiness RPC must confirm the companion migration actually emits
notifications before the engine advertises readiness.

Each socket owns its topic intent. Admission and every queued delivery evaluate
the exact existing private topic ACL through the original socket JWT, plus the
existing session-revocation guard. No club-channel membership cache substitutes
for the member-record/downline or roster/union ACL. Delayed joins, leaves,
reconnects and sibling tabs retain independent intent; the canonical
AUTH_STATE_CHANGED boundary rebinds even rapid A/B/A changes before React
renders and refuses retired callbacks; invalidations contain no
balances, notes, roles or statistics. Existing authoritative page readers still
supply all data. Repeated empty invalidations coalesce while the topic
frame awaits authorization/delivery, retaining one trailing invalidation for
commits during that interval. Every actually delivered frame still rechecks ACL;
no authorization verdict is cached.

The targeted hook retains its existing paid subscription until an authorized
engine topic acknowledgment confirms both the source and listener. Listener or
socket loss restores the compatibility subscription and marks the reader degraded.
Before or after engine admission, a Supabase SUBSCRIBED acknowledgment alone never marks
the reader fresh: the paid source may have been explicitly switched off.
Only an authorized engine-ready resync clears that transport degradation. Listener/socket reconnect causes one initial
reader refresh, covering missed notifications without a new polling loop.
The existing channel heartbeat also probes the dedicated socket with SELECT 1
so a half-open listener is retired; it never reads rows or refreshes UI data.
Unrelated Broadcast topics retain their existing transport.

## Delivery and cutover boundary

1. Install the companion NOTIFY migration with paid Supabase delivery still on.
2. Publish the engine through the existing certified engine route and the client
   through its independent static publisher. Either order is compatible: old
   engines or absent source readiness leave the paid fallback active.
3. Verify exact private ACL cases, revoked session, reconnect refresh, actual
   NOTIFY-to-page behavior and both deployed component identities.
4. Keep paid delivery for old open clients. A new client capability acknowledgment
   does not prove old tabs migrated. Root may disable the paid source only after
   explicit evidence covers active legacy viewers; no guessed grace period,
   blanket reload, forced logout, or mid-hand interruption is introduced here.

This source does not disable paid delivery, certify production savings, or install
its companion migration. Those are separate production acceptance steps.

Focused checks cover fallback/ready/lost behavior, per-socket topic isolation,
ACL revocation at delivery, stale join completion, and LISTEN reconnection/source
readiness. Existing channel replay/session and raw-session authority guards remain
applicable. TypeScript checked for both client and server. Production proof is
owned by root and remains pending until publication.

Real-time law: triggered by `PRIVATE_RECORD_CHANGED` discrete WS event, no snapshot diff.

## Cold-start readiness correction

Before this correction, the targeted hook accepted the paid fallback's SUBSCRIBED
status before the engine's first READY, and the roster could label its initial
HTTP snapshot live. Both exact private topic families now require their own
engine READY. Initial connection reports CONNECTING without an error toast; an
additive optional listener phase separates normal startup from actual source,
credential or socket failure. Other paid Broadcast events and wallet signals keep
their existing behavior. The roster keeps real offline/stale/degraded states ahead
of ordinary initial connection and requires record readiness before showing live.
The listener resets its phase on recovery. Account boundaries synchronously
retire old callbacks and require the new topic READY.

The original hook failed both cold-topic regressions; the original roster failed
the initial-successful-HTTP regression by reporting live. Focused repaired hook,
private-client and roster cases pass, including unrelated wallet/public/event
boundaries. Listener/topic tests cover initial credential failure, source refusal,
recovery and cleanup. Both TypeScript checks and ordinary submission hooks remain
required for the final candidate. This adds no timer, database change or polling.

## Hosted actor-fence source contract

Required server shard 4 failed its existing source guard because it pinned the old
single `const authoritativeHeaders` declaration. The compatible viewer-JWT path
requires a branch: only the two same-origin POST private-topic ACL reads omit
server actor markers; ordinary service and tournament-manager requests still
stamp immutable authority inside every fetch attempt. The guard now asserts that
ordinary else branch and the viewer origin/method/RPC refusal boundary explicitly,
while retaining its retry placement, outgoing-header, context and sole-client
assertions. Existing runtime actor and viewer-JWT tests remain applicable. This
correction changes the test contract only; no runtime or database bytes change.
