# The Provisioner Does Not Trust The Copy Of Itself That It Is

Before: `scripts/agent-workspace.sh` is invoked from the main clone, and the main clone's working tree is kept current by nothing at all. On 2026-09-11 the Club Arena clone sat 630 commits behind origin/main with 408 staged entries left over from an abandoned index, and two separate failures came out of that in a single morning.

The first was immediate: `./scripts/agent-workspace.sh` is mode 100644 in that stale tree and answered `Permission denied`, while origin/main has carried it at 100755 all along. The World Hub's copy was worse — it lost the executable bit on 2026-08-24 in a parity restore and had been refusing the documented command for eighteen days, in the repository where an agent is most likely to be following written instructions rather than improvising.

The second was quieter and much worse. The copy that did run was the pre-2026-09-10 provisioner: the one that judges `node_modules` against the MAIN CLONE's lockfile instead of the tree's. That is precisely the defect fixed in #4205 and synced to the Hub in #1735, and a stale working tree quietly reintroduced it. Every tree claimed from that clone would have come up short of its own lockfile again, and the agent would have read the same confusing `tsc` failure that took three manual repairs on 2026-09-08.

The worktree itself was never in danger — it is cut from `origin/main` a few lines further down, whichever copy is running. The danger is entirely that the LOGIC doing the cutting is old, and an agent has no way to tell, because the script prints the same confident banner either way.

Correction: the script now fetches `origin/main`, compares itself against `origin/main:scripts/agent-workspace.sh`, and when they differ hands over to main's copy with `exec`. `AGENT_WORKSPACE_REEXEC=1` is set on that exec and read before the comparison, so the copy handed to does not turn round and hand over again. The handover happens immediately after the variable block and before anything is created — a handover after `git worktree add` would leave main's copy inheriting a tree the stale copy had already made, which is the one arrangement worse than either script running alone.

It hands over rather than warning, deliberately. A warning asks an agent to decide whether a 630-commit-old provisioner matters, with nothing to decide it with. What it does print is the fact that is actually useful: which clone it was invoked from and how many commits behind that clone is.

The executable bit is restored in the World Hub, and both repos now assert it in git rather than on disk, because a checkout takes its mode from the index.

Verification: proved by running it, not by reading it. The patched script was invoked from the stale Club Arena clone while `origin/main` still held the old copy, and it printed

```
# this copy of agent-workspace.sh differs from origin/main - running main's copy instead
#   (the clone at /Users/smarter.poker/Documents/club-arena is 630 commit(s) behind)
```

then main's copy went on and created the worktree normally. The probe tree and its branch were removed afterwards.

The worktree law test in each repo gains five assertions: that the script fetches and compares itself, that it execs rather than warns and cannot loop, that it reports how far behind the clone is, that the handover is ordered before `git worktree add`, and that the file is 100755 in the index. Dropping any one of them turns the suite red. The two copies of the script remain byte-identical, which the existing parity assertions continue to require.

Not changed: the other World Hub shell scripts that are also 100644 in the index (`check-unpushed-work.sh`, `check-canonical-clone.sh` and eight more). Every one of them is invoked as `bash <path>` by this script or by a hook, so the mode does not decide whether they run, and there is no evidence of any of them failing. `agent-workspace.sh` is the one a human is told to type.
