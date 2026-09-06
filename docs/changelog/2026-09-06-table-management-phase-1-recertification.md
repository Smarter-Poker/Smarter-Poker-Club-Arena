# Table Management Phase 1 Recertification

## Finding

Two later cash-game migrations weakened Phase 1 without changing its original
tests. The current close and update helpers again ignored nullable participant
rows, and the current cash-game creator let `is_club_admin` bypass the
union-aware `fn_can_create_games` decision. The live `tables` INSERT policy
carried the same bypass for a private table, and a legacy direct DELETE policy
still advertised an operation the lifecycle trigger correctly refuses.

The lifecycle triggers still prevented the destructive close or tournament
edit, but the command receipt degraded to `command_failed` instead of the
operator-facing occupied/registered notification. The creation bypass was
fully reachable by a direct authenticated RPC from an affiliated club admin.

## Repair

- Restored all-seat and all-registration decisions in the current private
  update and close helpers. Horse, system, and nullable-user rows count.
- Preserved the current cluster shutdown behavior when an empty Main table is
  deliberately closed.
- Moved the mature cash-game creator behind a private implementation name and
  restored its public signature as a wrapper that requires
  `fn_can_create_games` with no club-admin alternate.
- Replaced the direct table INSERT policy with the canonical union-aware check
  and removed the operator DELETE policy. Tables close; they are not deleted.
- Reasserted that update and close remain private behind
  `fn_execute_managed_game_command`.
- Added a chronological migration-law test so a later function redefinition
  cannot silently revive either regression while the original Phase 1 file
  stays green.

## Publication

The production database recorded migration `20260906091511` before the code
release. Merge, publish provenance, and post-deploy results are recorded in the
Phase 1 completion summary after the automated release chain finishes.
