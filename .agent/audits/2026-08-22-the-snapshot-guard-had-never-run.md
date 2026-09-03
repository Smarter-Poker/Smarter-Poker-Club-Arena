# Audit — "a snapshot of every working tree runs every ten minutes" was not true

**Date:** 2026-08-22 · **Repo:** Smarter-Poker-Club-Arena · **Author:** Claude (Cowork session)

`AGENT-PLAYBOOK.md` §3 lists `scripts/install-wip-snapshot-agent.sh` under
**"Your work cannot be destroyed"**, and §9 tells an agent who thinks it has
lost work that it "almost certainly has not". Both rest on one claim:

> A snapshot of every working tree runs every ten minutes.

It had run **73 times and captured nothing**, for at least twelve hours,
while `agent-trees-audit.sh` was simultaneously reporting **nine trees at
risk** — one of them the shared Club Arena clone with 46 uncommitted files.

```
$ bash scripts/agent-trees-snapshot.sh --list
snapshots in Smarter-Poker-Club-Arena:
                                            <- nothing. not one, ever.
```

The estate's own stated failure mode, in the guard that underwrites every
other one: _"every failure this estate has had hid behind something that
reported success."_

---

## 1. WHY NOBODY SAW IT

The runner printed a per-repo line only when that repo produced output:

```bash
case "$OUT" in
  *"nothing to capture"*) : ;;      # silence is the normal case
  *) printf '%s:\n%s\n' ... ;;
esac
```

So the log was 73 bare timestamps and nothing else, which reads exactly like
"all quiet". It actually meant **"I did not look anywhere."** Those two states
were indistinguishable by design.

---

## 2. FAULT ONE — discovery asked the working tree

```bash
[ -f "$repo/scripts/agent-trees-snapshot.sh" ] || continue
```

Commented as _"covered the moment it carries the script"_. It asks the
**working tree**, which is precisely the thing that goes stale. The shared
Club Arena clone sits **160 commits behind `origin/main`**, from before the
script existed — so the file is not there. Nor is it in any of the other 25
clones under `~/Documents`:

```
MISSING  Smarter-Poker-Club-Arena     <- runner skips it silently
MISSING  Smarter-Poker-World-Hub      <- runner skips it silently
...  26 of 26
```

**Zero repos matched the predicate.** Every run skipped everything.

**Fixed:** the script is copied next to the runner at install time and used
whenever the repo's own copy is absent. A stale checkout can no longer switch
the safety net off.

---

## 3. FAULT TWO — macOS TCC. It would have survived fixing fault one.

`~/Documents` is a TCC-protected folder. An unprivileged launchd agent may
**stat** a known path inside it but may not **open** one. Same script, same
`$HOME`, same uid, measured both ways:

```
                                          shell            launchd
ls ~/Documents                            rc 0             Operation not permitted
"$HOME"/Documents/*/  matched             40               1  (the pattern, unexpanded)
cat <repo>/.git/HEAD                      ref: .../main    Operation not permitted
git rev-parse --git-common-dir            .git             fatal: Unable to read
                                                           current working directory
[ -d "<repo>/.git" ]                      yes              yes      <- BOTH TRUE
```

That last row is why nothing looked wrong: the existence test the runner used
passes under launchd. Only the read fails.

**One repo in the list did work** — a since-retired repo whose realpath was a
symlink out of the
protected folder. The folder is the boundary, not the path. That single
success is also what made the first version of my own verification check pass
falsely; see §5.

**Fixed, as far as code can fix it:**

- The repo list is resolved **at install time**, in a shell that has TCC
  access, and written to `~/Library/Application Support/poker-agent-wip-repos.txt`.
  The runner reads that file and stats each path directly. It never globs a
  protected directory.
- The runner reports **every** repo — captured N / nothing to capture / not a
  git repository / unreadable — and always prints the totals. Silence can no
  longer be mistaken for nothing-to-do.

The remaining half is a **human consent action and nothing in this repo can
perform it**: Full Disk Access for the launchd program. The installer now says
so, in those words, with the exact steps, and refuses to claim success.

---

## 4. WHAT IS TRUE RIGHT NOW

- **From a shell the script works perfectly.** Run manually during this
  session it captured **9 snapshots** immediately, including the shared clone's
  40 modified files and unpushed commits in `ca-bundle`, `ca-tip`, `ca-xp`,
  `ca-fin2`, `ca-land`, `ca-ci-76061`. That work is now in `refs/wip/`, which is
  where the playbook always said it was.
- **The ten-minute automation still captures nothing** for the 25 repos that
  physically live in `~/Documents`, and will continue to until the grant
  exists. It is now loud about that instead of silent.
- Until then, the honest workaround is one line at the start and end of a
  session:

  ```bash
  bash scripts/agent-trees-snapshot.sh          # takes ~1s
  bash scripts/agent-trees-snapshot.sh --list
  ```

---

## 5. THE CHECK I GOT WRONG FIRST, RECORDED DELIBERATELY

The verification I added to the installer initially read:

```bash
if grep -q 'captured\|nothing to capture' "$LOG"; then PROBE_OK=1; fi
```

and printed **`verified: the agent can read the repos`** — because
the one symlinked repo produced "nothing to capture"
while the other 25 were blocked. A check that passes when _any_ subject
succeeds is the same false green this entire audit is about, reintroduced by
the fix for it.

It now reads only the most recent run block and requires **zero** repos to
have come back unreadable. Recorded rather than quietly corrected, because the
mistake is more instructive than the fix.

---

## 6. WHAT IS OWED, AND TO WHOM

1. **Full Disk Access for `/bin/bash`** (System Settings → Privacy & Security),
   then `bash scripts/install-wip-snapshot-agent.sh`. One-time, per machine.
   Genuinely human-only — TCC has no programmatic grant. The installer prints
   this verbatim and will keep printing it until it can prove otherwise.
2. **`AGENT-PLAYBOOK.md` §3 overstates the guarantee.** The sentence
   _"Runs that snapshot every 10 minutes as a launchd agent"_ should say that
   it does so **once Full Disk Access is granted**, and point at
   `bash scripts/install-wip-snapshot-agent.sh --status`, which now reports the
   truth either way. Not edited here on purpose: the playbook is in
   `estate-integrity.sh`'s byte-identical set, so it has to change in all seven
   repos in one pass or it becomes the drift it is meant to prevent.
   `scripts/install-wip-snapshot-agent.sh` is **not** in that set, which is why
   this fix ships to the canonical repo alone.
