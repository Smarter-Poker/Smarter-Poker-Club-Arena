---
description: MANDATORY — determine which execution mode you are in BEFORE promising to push, deploy, or run SQL. Cloud-mode agents physically cannot reach the network.
---

# Agent Execution Modes — read before you promise a deploy

> **The #1 cause of stalled deploys in this repo is an agent that finished the
> work, said "pushing now", and then discovered it has no network.**
> Check your mode first. It takes one command.

---

## The two modes

|                       | **On your computer** (Claude Code / Cowork local) | **In the cloud** (Cowork cloud session)    |
| --------------------- | ------------------------------------------------- | ------------------------------------------ |
| Shell runs on         | your Mac                                          | an isolated Linux VM + a cloud container   |
| Network from shell    | ✅ full                                           | ❌ none                                    |
| `git push`            | ✅ works                                          | ❌ impossible                              |
| `psql` / Supabase CLI | ✅ works                                          | ❌ impossible                              |
| `npm run build`       | ✅ works                                          | ❌ (macOS-only binaries in `node_modules`) |
| `BypassSandbox: true` | ✅ meaningful                                     | ❌ parameter does not exist                |

---

## Step 0 — Detect your mode (do this first)

```bash
getent hosts github.com >/dev/null 2>&1 && echo "NETWORK: yes" || echo "NETWORK: no"
```

- **`NETWORK: yes`** → you are on the user's computer. Run the full pipeline
  yourself (see _Full protocol_ below). Never hand off.
- **`NETWORK: no`** → you are in a cloud session. You **cannot** push, pull,
  fetch, `npm install`, or reach Supabase. Plan around it from the start; do
  not discover it at the end.

Corroborating signals for cloud mode:

- the repo is mounted under `/sessions/<id>/mnt/<folder>` rather than
  `/Users/<you>/Documents/...`
- `ls node_modules/@next/` shows only `swc-darwin-arm64` (macOS binary) while
  your shell is Linux — so `next build` cannot run either
- `curl https://registry.npmjs.org` returns `403` (egress allowlist)

---

## What does NOT work in cloud mode (all verified, 2026-08-03)

Do not burn turns rediscovering these:

- `BypassSandbox: true` — **not a parameter in cloud sessions.** The nearest
  equivalent (`dangerouslyDisableSandbox`) was tested against both
  `github.com` and `smarter.poker`: still `403`. The block is an
  infrastructure egress allowlist, **not** the sandbox, so disabling the
  sandbox changes nothing.
- The cloud container — `403 CONNECT tunnel failed` to github.com and to
  registry.npmjs.org.
- The device VM — **no DNS at all.** `git push` fails at name resolution.
- Computer-use on Terminal — grants in **click-only** tier. You can see and
  click; you cannot type, so you cannot run a command.
- GitHub API (`push_files`) — technically reachable, but it forks history
  against a fast-moving `main` and leaves the user untangling a divergence.
  Do not use it to "push" ordinary work.

**What cloud mode CAN still do:** read and write files in the mounted repo,
`git add` / `git commit` locally, run `node`/`node --test` (so the
`__tests__/` guards work), and run ESLint from the repo's own `node_modules`.

So the correct cloud-mode endgame is: **do the work, verify it statically,
commit it locally, and tell the user the single command.** One command is a
reasonable ask. Ten messages of "let me try another way" is not.

---

## Full protocol (on-your-computer mode only)

```bash
cd ~/Documents/club-arena

# 1. Locks — git can create these but a crashed process leaves them behind
rm -f .git/index.lock .git/HEAD.lock .git/next-index-*.lock

# 2. Verify the Club Arena build BEFORE committing.
npm run build            # must reach a completed build

# 3. Stage precisely. `git add -A` will sweep up other sessions' WIP —
#    this repo frequently has 200+ files staged by a concurrent agent.
git add -- <your paths>
git diff --cached --name-only | wc -l    # sanity-check the count

# 4. Commit. Hooks are mandatory; fix every refusal at its source.
git commit -m "..."

# 5. Merge current main without rewriting branch history, then push the branch
git fetch origin main
git merge --no-edit origin/main
git push origin HEAD:refs/heads/fix/<slug>

# 6. Follow Club Arena's own checks, merge, and Hetzner publishers to terminal
# state. Then verify the exact merged SHA at both frontend endpoints.
curl -fsS -H 'Cache-Control: no-cache' https://ca-static.smarter.poker/build-info.json
curl -fsS -H 'Cache-Control: no-cache' https://smarter.poker/hub/club-arena/build-info.json
```

### The Pre-Commit Hook

Hook refusals are release evidence, not optional lint. There is no
`--no-verify` exception. Repair an incorrect rule in a reviewed change or fix
the source that violates it; never bypass all checks to move a commit.

---

## Build guards (they run in `prebuild` — do not weaken them)

- `__tests__/menu-routes-exist.test.mjs` — every hamburger menu href must
  resolve to a real page. Routes served outside the pages router (e.g. the
  club-arena SPA via `next.config.js` `rewrites().fallback`) go in
  `KNOWN_MISSING` **with a verified reason**, never just to make it green.
- `__tests__/pa-no-undef.test.mjs` — ESLint `no-undef` + `react/jsx-no-undef`
  across the Personal Assistant surface. This exists because a single
  undefined identifier (`user`, `M`, `effStack`, `coachStreak`) white-screens
  a whole page with **no build error**. It has caught six live `authError`
  ReferenceErrors that code review missed.

Both are registered in `__tests__/_test-guards-exist.test.mjs` so they cannot
be deleted silently. If one fails, fix the code — not the guard.

## Never write `<style jsx>` on the Personal Assistant surface

A large `<style jsx global>` block in `leaks.js` caused a **45-minute SWC
compiler deadlock** that silently blocked every production deploy
(fixed in `17409efc08`). Use:

```jsx
<style dangerouslySetInnerHTML={{ __html: `...css...` }} />
```

For a `global` block this is an exact behavioural swap, except the CSS lands
in the body rather than `<head>` — so it wins same-specificity ties it
previously lost. Bump specificity explicitly if a rule needs to lose one.

---

## SQL migrations — last, and never speculatively

Write to `supabase/migrations/` with a timestamped filename and apply with
`npm run db:push`. Never open the Supabase dashboard (Cloudflare captcha).
In cloud mode you cannot reach the database at all: write the file, leave it
**unapplied**, and say so. Migrations are irreversible in production — an
agent that cannot verify the result should not be running them.
