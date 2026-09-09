# tests/a-worktree-gets-a-node-modules-that-works.law.test.ts

`scripts/agent-workspace.sh` is byte-identical across this estate and it
provisions every agent worktree by cloning the main clone's `node_modules`.
On 2026-09-08 the World Hub's main clone held ONE package, typescript, after a
`git-safe-push` clean and an install that rolled back. The provisioner cloned
that one package faithfully into every tree claimed that day: no `tsc`, no
build, and a pre-push hook that died on `ERR_MODULE_NOT_FOUND` naming a path
and explaining nothing. Three trees were repaired by hand before anybody
looked at the script, and the script's own probe-and-repair step had been
printing "No such file" for weeks because it called a
`scripts/check-node-modules.sh` the World Hub did not have.

The provisioner now judges a source by its PAYLOAD rather than its presence
(`typescript`, `.bin/tsc`, a real population), borrows from the freshest
sibling worktree whose `package-lock.json` is byte-identical to the main
clone's, and repairs the main clone in place when nothing can donate. This
law pins those three behaviours and that the repair script this repo names
actually exists, because a guard that differs between repos is a guard that
is only true where somebody last looked. The fix landed in the World Hub as
#1658 and is copied here byte for byte.
