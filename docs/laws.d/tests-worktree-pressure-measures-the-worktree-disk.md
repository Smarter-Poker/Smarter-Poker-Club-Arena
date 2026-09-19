# tests/worktree-pressure-measures-the-worktree-disk.law.test.ts

A free-space number with no filesystem attached is worse than no number, because
everyone believes it.

`worktree-pressure.sh` was written on 2026-09-07, when the Mac reached 100% of a
926 GiB internal disk with 224 worktrees. It measured `df -g "$HOME"`, which was
correct then. The worktrees later moved to `/Volumes/SmarterWork/agent-work`
under AGENTS.md, and the reader did not move with them.

On 2026-09-19 that volume hit 99.9% of its 274.9 GB APFS quota - 313 MiB free -
while the device beneath it was only 40% used and `$HOME` had 110 GiB. `npm ci`
died with `ENOSPC` inside a pre-push gate; the gate refused the push; and on the
same run this reader printed `110 GiB free, 539 worktrees registered`. Every
statement in that line was true and the conclusion it invited was wrong. The
engine had been unable to release for sixteen hours behind an unrelated fault,
and the one guard positioned to notice the disk was reassuring people about a
different disk.

So the law is not "check the disk". It is: measure the filesystems the worktrees
are actually on, and say which one you judged. `df` is asked about each
registered worktree and about `$HOME`, answers are deduped by the mount `df`
itself reports rather than by guessing at path shapes, and the tightest one is
what gets compared to the floor and named in the warning. A machine that still
keeps its trees in `$HOME` behaves exactly as before.

The test replaces `git` and `df` with fixtures so it can state which trees exist
and how full each filesystem is; the real ones would make it depend on whichever
machine ran it. Three of its four cases fail against the pre-2026-09-19 script
and pass after, which is the point of keeping them.

It stays a warning and never blocks. A full disk is bad; a hook that refuses to
let someone save their work because a disk is nearly full is worse.
