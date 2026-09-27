# Connected presence and balance acceptance

The existing production customization journey now observes the already shipped
presence and account balance changes with its two reserved identities. It checks
that the existing public Midway Union is readable before navigating, then proves
actual Presence joins, leave, reconnect and the displayed online count. A 65-second
observation requires unchanged Presence to remain quiet while SDK heartbeats
continue. The observer preserves separate device references for one player.

The balance check observes the real authenticated own-membership subscription,
successful initial and reconnect reads, retained persisted balances during the
network interruption, and the wallet's rendered Playable Now amount against the
same account's authorized source rows. It does not write balances, add or remove
memberships, send chips, or claim to induce a cross-device financial mutation.
The existing isolated-account lifecycle and cleanup remain unchanged.

Two parser regressions distinguish device references from player counts, heartbeat
traffic from Presence tracks, and own from other-account subscription receipts.
Local focused verification: 44 tests across five files and TypeScript passed.
Protected publication and actual production journey results remain separate
evidence; test source is not live acceptance.
