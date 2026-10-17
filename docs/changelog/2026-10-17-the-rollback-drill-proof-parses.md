# The rollback drill's independent proof parses (2026-10-17)

The first live DA10 rollback drill, run 39050314819, sealed a rollback from `1ac50f38` to `68f452ce` inside the 17:55 UTC break. The transaction's receipt says `sealed`, and the engine serves `68f452ce` as the fresh leader.

The workflow then failed its own independent proof with `bash: syntax error near unexpected token (`. A comment inside the single-quoted `python3 -c '...'` body of the remote proof script read "The engine's own leadership witness". The apostrophe ended the quote, so the remote bash could not parse the script. The law test pinned the step's text but never parsed it.

- **The fix:** `.github/workflows/engine-rollback-drill.yml` moves that comment out of the quoted body, and adds a note above the step that nothing inside a single-quoted `python3 -c` body may contain a single quote.
- **The law:** `tests/rollback-drills-ride-the-release-lane.law.test.ts` now parses every step of the workflow, and every `<<'NAME'` heredoc body shipped to the host's bash, with `bash -n`. Against the shipped workflow it fails on exactly this step. The same check passes for `engine-drill.yml` and `auto-deploy-hetzner.yml`.

Nothing in production depended on the failed step. The roll-forward drill runs after this fix and re-proves identity end to end.
