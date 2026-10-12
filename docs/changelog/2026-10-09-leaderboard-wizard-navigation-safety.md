# Leaderboard Wizard Navigation Safety

An opening or prize-setup save could finish after an account or club change closed its wizard. Its stale callback could then update the newly displayed account or club. A template publication could also start another club write after its editor had departed.

Each wizard now retires asynchronous interface work when it leaves its submission lifecycle. Completion and error callbacks check that lifecycle after waits; template publication checks before every subsequent request. Already submitted transactions retain their original identities and outcomes, with no cancellation or extra retry.

Six deferred-response cases reproduced the stale callbacks, stale toast and continued template work before the repair. The same cases pass afterward. This independently deliverable change retains current funding behavior and approved artwork; the separately drafted Promo-only financial change still requires its own actual qualification and installation.
