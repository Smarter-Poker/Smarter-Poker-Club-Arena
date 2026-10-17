# Preserve the retired bootstrap's historical proof

Client publisher 39009880537 failed its immutable-source regression. PR #7228 retired the old 50-row board bootstrap through the maintained superseded registry and pinned its historical SHA256. Concurrent PR #7211 changed that same retired file's proof comment to `>= 50`, so publication correctly refused the changed bytes.

Restore only the original proof comment and remove its new explanation. The historical file again has SHA256 `eb04461506dfa6b47ad6294755a600a3c7e23e8c4e80f611622f3c5ae901c99b`. Preserve the registry's specific supersession by migration 20261016182049, the installed ownership guard, and all executable SQL from both PRs. The superseded bootstrap is never replayed and its obsolete row count is never used to certify the evolved board.

The existing regression fails before (one failure, 15 passes) and passes after. No database installation, schedule, financial record, engine or client runtime change is required. This repairs the demonstrated publication blocker for the mobile post-deploy checks.
