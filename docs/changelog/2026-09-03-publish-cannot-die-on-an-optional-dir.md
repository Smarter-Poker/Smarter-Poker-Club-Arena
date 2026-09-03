# A missing `dist/fonts` could stop the publish outright

**2026-09-03.** Found by auditing the new origin publisher rather than by an
outage - it had not fired yet, and it would have looked like a build problem
when it did.

## The bug

The pool upload was two unguarded rsyncs between the release upload and the
symlink swap:

    rsync -az ... dist/assets/ ...:$ORIGIN_ROOT/pool/assets/
    rsync -az ... dist/fonts/  ...:$ORIGIN_ROOT/pool/fonts/
    $SSH "set -e; ... ln -sfn ... && mv -Tf current.tmp current && ..."

`dist/fonts` is not guaranteed. `scripts/self-host-fonts.mjs` is deliberately
non-fatal: it returns early when `dist/index.html` is missing, when it finds no
Google Fonts URL in the HTML, and on any download failure ("non-fatal, Google
Fonts links remain"). No font file is committed to this repo. So a build with
`fonts.gstatic.com` unreachable from the runner produces no `dist/fonts` at
all - and rsync exits **23** on a missing source directory.

Under `set -euo pipefail` that killed the job at exactly the worst point: the
new release was already uploaded to the origin, `current` still pointed at the
old one, nothing shipped, and the red job named rsync and a temp path. Nobody
reading that would look at the font script.

Verified on GNU coreutils, both directions: the old shape exits 23 and leaves
no `current` symlink; the guarded shape publishes and `current` resolves to the
new release.

## The other half

Once `mv -Tf` has run, **the site is live.** Pruning old releases and ageing
the pool were chained onto that same `set -e` command, so a failure while
tidying up would have reported a shipped release as a failed publish - and the
next agent would have "fixed" a publish that had already worked.

They are separated now. The swap is the only thing under `set -e`; housekeeping
runs in its own call and its failure is a warning that says the release IS
live. The next run retries the tidying anyway.

## Also fixed: the origin config could be left broken on disk

`infra/ca-origin/deploy-origin-config.sh` scp'd straight onto
`/etc/caddy/Caddyfile` and validated **afterwards**, so an invalid config left
a broken file on disk and merely exited 2. That looks survivable because the
running Caddy keeps serving from its in-memory config - until the next reload,
restart or reboot, at which point this origin, which is now in front of every
Club Arena page load, serves nothing.

It stages to `Caddyfile.staged`, validates the staged copy, and only then moves
it into place. The outgoing config is kept as `Caddyfile.prev`, and a reload
that fails on an otherwise-valid config rolls back to it.

## Pins

`tests/the-publish-cannot-die-on-an-optional-dir.law.test.ts`, three pins, each
mutation-verified: restoring the bare `dist/fonts` rsync, chaining the prune
back onto the swap, and putting `set -e` back on the housekeeping call each
turn the matching test red.
