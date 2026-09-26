# Live membership balances reach every route

The global financial listener watched `public.wallets`, the retired and
unpublished pool. Actual player balances come from `club_members`. Its existing
user-filtered, published subscription only emitted a club-page refresh, leaving
the global balance and persistent wallet store without the matching signal.

This change reuses that subscription. Chip, promo and locked-balance changes
coalesce into one account balance invalidation. Activity-counter-only updates
no longer reload club pages. Membership/role changes retain their club refresh;
an own-membership deletion invalidates access and balances. The live primary
key was verified as `(club_id,user_id)`, and DELETE callbacks explicitly check
both because Supabase does not filter DELETE delivery.

Every old-channel callback is fenced by a subscription generation, including
same-account teardown/rejoin. Reconnection refreshes authoritative balances.
The existing app-level balance owner also refreshes the persistent wallet store
on routes without a header. Unknown reads retain known amounts; no money command,
grant, database publication, engine protocol or scheduled repair is changed.

Seven actual service callback regressions failed before the balance repair.
Two further reconnect regressions reproduced a reset attempt counter and an
unnecessary replacement after successful recovery. The existing five-attempt
replacement budget now survives teardown; successful recovery resets it and
cancels the obsolete timer. The SDK's own socket recovery remains intact.
The focused suite covers burst coalescing, irrelevant writes, composite-key
deletion, account switches, late callbacks, reconnects and the persistent wallet consumer.
Compiler, full client/required checks, protected publication and affected live
proof are recorded separately; tests do not demonstrate invoice savings or a
production financial transaction.
