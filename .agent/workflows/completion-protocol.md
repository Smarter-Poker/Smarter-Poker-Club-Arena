> **SUPERSEDED 2026-09-03 - READ THIS FIRST.**
> Club Arena no longer publishes by committing its build into the World Hub
> repo. It publishes by rsync to its own origin, `https://ca-static.smarter.poker`
> (`/srv/club-arena` on the Hetzner box: `releases/<ca_sha>/`, an atomically
> swapped `current` symlink, an additive `pool/`), and the World Hub carries a
> single Next.js rewrite `/hub/club-arena/:path*` to it. `public/hub/club-arena/`
> is GONE from that repo and a law test refuses to let it back.
>
> **Every `sync-club-arena.sh` / `build-club-arena.sh` / `sync-to-world-hub.sh`
> command below is dead.** Those scripts are deleted from `main`. If you find one
> on disk you are on a stale branch - it still works, and running it would
> re-vendor the bundle and shadow the origin.
>
> **You do not publish by hand at all now:** push a branch, and
> `agent-open-pr` -> `agent-autopilot` -> `publish-club-arena` does the rest.
> The current path is `.agent/architecture/deploy-paths.md`.

---

## description: MANDATORY end-of-task protocol - deliver the exact branch through Hetzner, write SQL LAST

# Task Completion Protocol - MANDATORY FOR ALL AGENTS

**REWRITTEN 2026-09-04.** The banner above has been on this file since
2026-09-03 and the whole protocol under it was still the old one, in the
present tense and marked ZERO EXCEPTIONS: `git push origin main`, then
`scripts/sync-club-arena.sh` - deleted from main - then compare index hashes.
Every step of that is now either refused (main is a protected mirror) or
actively harmful (re-vendoring the bundle SHADOWS the live one, because Next
serves `public/` before the rewrite). A banner over a body that still reads as
law does not help a reader who skims into the middle of it.

## The Three Rules

### Rule 1: ALL testing on smarter.poker ONLY

- **NEVER** test on `localhost`, `127.0.0.1`, or any local dev server as your
  proof. The Vite dev server is fine for looking at something while you build.
- **NEVER** test on `club-arena.vercel.app` or any Vercel preview.
- **ONLY** claim behaviour verified on `https://smarter.poker`.
- See `/browser-testing` for the walkthrough scripts.

### Rule 2: Push a branch, then certify the exact release

```bash
# In your own worktree, never the shared clone
npx tsc --noEmit
git add path/to/file path/to/other-file
git commit -m "type(scope): what changed"
git push origin HEAD:refs/heads/fix/<slug>
```

`agent-open-pr.yml` opens the pull request, `agent-autopilot.yml`
squash-merges it when the required checks are green, and the Club Arena-owned
Hetzner workflows publish it. Follow those workflows to a terminal result,
fix forward on red, and certify the exact merged SHA at the direct origin and
public rewrite. For a `server/` change, also certify the sealed engine
cutover and cache-busted health SHA. Never substitute a World Hub or Vercel
deployment for this proof.

### Rule 3: Write SQL LAST - after building and testing

- **DO NOT** write migrations until the code is done and tested. They go to
  production immediately and cannot be undone.
- `supabase/migrations/<YYYYMMDD>_<desc>.sql`, applied through the Supabase MCP
  `apply_migration`, never raw `execute_sql`.
- One change = ONE transaction. Every DDL statement makes PostgREST reload its
  whole schema cache (~28s on this database); ten statements outside a
  transaction is up to ten reloads. See CLAUDE.md section 2.
- **NEVER** probe a money path against production. Roll it back, or reason
  about it in a unit test and say so (CLAUDE.md 11.5).
- **NEVER** open the Supabase web dashboard to run SQL (a Cloudflare captcha
  blocks it).

## Execution order

```
1. WRITE CODE     - in your own worktree, off fresh origin/main
2. TYPECHECK      - npx tsc --noEmit, zero errors
3. TEST           - npx vitest run <the tests covering your change>
4. BUILD          - npm run build, if you touched src/
5. CHANGELOG      - docs/changelog/YYYY-MM-DD-<slug>.md, YOUR OWN FILE
6. PUSH A BRANCH  - the Club Arena delivery pipeline starts
7. CERTIFY        - required checks, merge, Hetzner publish, exact live SHA
8. WRITE SQL      - only after everything else is confirmed
9. APPLY SQL      - Supabase MCP apply_migration, one transaction
```

## Verify - by reading, never by assuming

```bash
curl -fsS -H 'Cache-Control: no-cache' https://ca-static.smarter.poker/build-info.json
curl -fsS -H 'Cache-Control: no-cache' https://smarter.poker/hub/club-arena/build-info.json
```

`ca_sha` must equal the squash commit on `main`. Comparing index hashes against
your local `dist/` no longer proves anything: the publisher builds its own
bundle from the merge commit, so your local hash is a different build of
possibly the same source.

## What happens if you break this order

- SQL before code is done -> schema changes go live before the code using them.
- Testing on localhost -> false confidence, bugs in production.
- Not pushing -> the work is lost. `prune-stale-worktrees.sh` removes clean
  pushed worktrees after 72 hours, and Antigravity's periodic
  `git reset --hard origin/main` discards uncommitted work anywhere.
- Pushing to `main` -> refused by the ruleset. Push a branch.

## Do not end a session without

- [ ] Everything committed and the branch pushed
- [ ] `npx tsc --noEmit` clean
- [ ] The tests covering your change run, with a count you can paste
- [ ] A changelog file under `docs/changelog/` (never appended to
      MIGRATION-CHANGELOG.md - it is frozen history and was the single biggest
      source of merge conflict in this repo)
- [ ] Any new `*.law.test.*` registered in `docs/LAWS.md`
- [ ] Migrations written AND applied, and mirrored into `supabase/migrations/`
- [ ] The pull request merged with required checks green
- [ ] Both build-info endpoints serve the exact merged Club Arena SHA
- [ ] Any server change is sealed and the engine health reports that exact SHA
- [ ] The PR number and exact live release evidence reported

> [!TIP]
> If a change is not live, `/deploy-troubleshooting` works down the list from
> "what does build-info.json actually say".
