# Presence proof respects union ownership

The production Presence test introduced in PR5372 incorrectly treated a public
union as a player-visible page. `UnionDetailPage` redirects every non-owner to
Clubs. The fixture would therefore fail before proving the count, even though
the union's row is readable. No browser run reached that assertion: reserved
account cleanup failed first.

The same two reserved identities now exercise authenticated Supabase SDK
Presence on a disposable `cert-presence:<uuid>` topic. Real server Presence
state proves joins, leave and a fresh transport connection/rejoin. The65-second
quiet assertion retains real heartbeat replies and refuses an extra track or
join. No union, ownership, funding or financial write is added. Each additional
session signs out locally during teardown; Node20 uses the SDK's supported `ws`
transport.

This is provider transport evidence, not proof of the owner-only rendered union
count or the application's automatic Presence recovery. The13 existing actual
PresenceService behavioral regressions remain unchanged. The separate browser
test still verifies mounted own-member subscription/read, actual offline
recovery, persisted balances and the Wallet's rendered amount. It induces no
financial update and does not claim a cross-device money event.
