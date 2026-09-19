# The worktree pressure reader was watching the wrong disk

**2026-09-19**

`scripts/worktree-pressure.sh` runs on every push to warn that the machine is
running out of room for worktrees. It measured `df -g "$HOME"`.

The worktrees are not in `$HOME`. AGENTS.md puts them under
`/Volumes/SmarterWork/agent-work`, an APFS volume with a 274.9 GB quota on a
device that is only 40% used. Today that volume reached 99.9% of its quota with
313 MiB left. `npm ci` failed with `ENOSPC` in the middle of a pre-push gate,
the push was refused, and the same run printed `110 GiB free, 539 worktrees
registered` - a true reading of `$HOME` and a useless one about the disk that
had filled.

The reader now asks `df` about each registered worktree and about `$HOME`,
dedupes by the mount `df` reports rather than by guessing at path prefixes,
compares the tightest filesystem against the floor, and names it:

    [worktree-pressure] 16 GiB free on /Volumes/SmarterWork, 539 worktrees registered.

539 trees across three volumes cost three comparisons; the whole reader takes
1.9 s on this machine. Behaviour on a machine whose trees live in `$HOME` is
unchanged, and it still warns rather than blocks.

`tests/worktree-pressure-measures-the-worktree-disk.law.test.ts` stubs `git` and
`df` so the scenario is stated rather than inherited from the host. Three of its
four cases fail against the old script and pass against this one.

Separately and not fixed here: the volume was full of 43 GB of `gha-tmp` and
46 GB of `gha-cache` belonging to self-hosted runners that have been offline for
days, and the ceiling of 150 trees has been exceeded by 389.
