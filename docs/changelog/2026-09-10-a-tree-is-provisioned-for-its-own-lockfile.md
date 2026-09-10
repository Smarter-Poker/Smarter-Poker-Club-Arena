# A tree is provisioned for its own lockfile

## What was wrong

`scripts/agent-workspace.sh` clones `node_modules` from the main clone into
every new tree. It judged that install as usable (typescript present, `tsc`
present, more than a hundred packages) and it was; it was also 25 commits
old. The main clone sat behind `origin/main` with 400 dirty entries, so its
lockfile named 410 top-level packages and the tree's named 430. Every tree
claimed from it came up with `tsc` failing on a package the tree's lockfile
named and the install did not have, the pre-push hook refused, and every
agent ran `npm ci` by hand after reading the same unhelpful error. The
sibling-donor search added on 2026-09-08 could not help: it compared
candidates against the main clone's lockfile, which was the stale one.

`server/node_modules` had the same shape one level down: the clone lacked
`pg` and four of its dependencies, which the engine's accounting tests need.

## What changed

- `node_modules_matches_lockfile`: npm's own record of what it installed
  (`node_modules/.package-lock.json`) is compared with a lockfile; every
  top-level, non-optional package must be present at the lockfile's version.
  Optional platform packages are skipped because npm leaves all but one empty
  by design.
- The reference lockfile is the TREE's, for the main clone and for every
  donor. A donor must be byte-identical in lockfile and satisfy it.
- A clone that still does not satisfy the tree's lockfile is finished with
  `npm ci` in the tree itself, which the script's own 2026-08-23 note
  established is safe: the tree owns its `node_modules`.

Measured on this Mac: a fresh claim now reports the main clone as behind,
clones root from a matching sibling, catches a sibling whose own install was
mid-`npm ci` at that moment (verify-after-clone), and finishes `server/` with
a three-second `npm ci`. The tree typechecks. Before the change the same
claim produced a tree that did not.

- `.node_modules-sGtZATtc`, a symlink to an absolute path on one machine's
  disk, committed on 2026-08-22 from the old `ln -s` era, is removed. The
  `.gitignore` pattern that would have stopped it landed a day later.

## The estate

`agent-workspace.sh` is on the estate-integrity list of files that must be
byte-identical in all seven repositories. It was not: Club Arena and the
World Hub carried the 2026-09-08 donor fix and the other five did not. The
version here is being opened, byte for byte, in all six others.
