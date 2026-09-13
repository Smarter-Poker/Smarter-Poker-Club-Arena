# 2026-08-15 — Antigravity work queue (from the eight-item table audit)

Written by Claude after closing Dan's eight in-game table items. Everything here
is either something I could not do myself, or something I found and deliberately
did not do blind at the end of a long session. Ordered by risk, not effort.

Each item is self-contained: do not assume you can read `.memory/` (gitignored).
Context lives in `.agent/audits/2026-08-15-table-ux-eight-item-audit.md`.

---

## P0-1. Verify containment of the engine-host root compromise

**Why:** CA commit `0eec5922c` records a root compromise of the engine host with
an XMRig miner, and says containment was performed. Nobody has independently
verified that since. A miner implies arbitrary code execution as root, so every
secret that host could read must be considered disclosed.

**Do:**

1. Read `0eec5922c` in full. Establish the entry vector and the window.
2. On the Hetzner engine host, check for persistence, not just the miner:
   `systemctl list-units --all | grep -iv '\.mount'`, `crontab -l` for every user,
   `/etc/cron.*`, `~/.ssh/authorized_keys` for every account, `/etc/systemd/system/*`,
   and any unit whose `ExecStart` is outside `/usr` or `/opt`.
3. Rotate everything that host holds: `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
   any deploy key in `~/.ssh`, and the GitHub deploy token used by
   `auto-deploy-hetzner.yml`.
4. Confirm the service-role key rotation propagates to Vercel env AND the
   Hetzner env, or settlement breaks.
5. Write findings to `.agent/audits/`.

**Done when:** a written statement of entry vector, persistence found/not found,
and a rotation list with timestamps.

---

## P0-2. A live GitHub PAT is printed to stdout by a git hook

**Why:** `Smarter-Poker-World-Hub/.git/hooks/reference-transaction` has a
`ghp_` token hardcoded in its error message and echoes it whenever it blocks a
reset. It printed into an agent session today. Anything scraping terminal output
or CI logs has it.

**Do:**

1. Revoke that token immediately.
2. Rewrite the hook to read from a credential helper or `gh auth token`, never a
   literal. The hook's job is to block orphaning resets; it does not need a token
   at all — it only needs to _suggest_ a push command. Print `git push origin main`
   and drop the authenticated URL entirely.
3. Grep both repos' `.git/hooks/` and `.husky/` for any other embedded secret.

**Done when:** old token revoked, hook contains no credential, grep is clean.

---

## P0-3. Decide whether chip-conservation violations should block settlement

**Why:** `server/src/engine/StateVerifier.ts` computes
`sum(stacks) + rake + bbj == initial` correctly (`:353-435`) — then on violation
calls `reportError()` and **continues**. A hand can pay out while the books do
not balance. `ChipConservationVerifier.ts` is stricter but is flag-gated
observe-only behind `eventShadowEnabled`.

This is a product decision, not a bug: blocking risks freezing a table mid-hand
(and Dan's hard rule is games must never freeze), while continuing risks paying
out an unbalanced hand.

**Do:** put the options to Dan with numbers — query how often the check has
actually tripped in production before proposing. If it has never tripped,
blocking is cheap insurance. If it trips regularly, find out why first.

**Done when:** Dan has chosen, and the chosen behaviour is implemented + tested.

---

## P1-1. The server has no test of the real rake schedule

**Why:** every server rake test — `HandController.audit`, `basicplay`,
`reopening`, `bigblindante` — builds `rakeConfig: { percent: 5, cap: 100,
noFlopNoDrop: true }`. That is synthetic: 5% is not our rate, and **a cap of 100
never binds, so the cap law is never exercised server-side.** Those tests prove
mechanics (uncalled bets excluded, no-flop-no-drop, chip conservation). Nothing
proves the engine applies the real caps.

The client side is now covered: `tests/unit/RakeConfig.schedule.test.ts` (32
tests) plus `scripts/ci/check-rake-schedule-parity.mjs`, which pins the client
schedule to the server's. The missing link is the engine actually honouring it.

**Do:** add server tests that drive `PokerEngine.calculateRake` /
`HandController.completeHand` with real `getFullRakeConfig()` values and assert:
10% is taken; the tier cap binds on a large pot at 0.1/0.2 ($3), 1/2 ($5) and
10/25 ($15); heads-up and 3-handed cap reduction applies; no-flop-no-drop holds.

**Done when:** a pot large enough to hit the cap is proven to be capped.

---

## P1-2. Audit the second poker engine in World Hub

**Why:** `Smarter-Poker-World-Hub/src/lib/poker-engine/` contains a separate
engine (`LobbyManager.js`, referenced by `src/components/poker/PokerLobby.jsx`)
with its own `record-rake.js` → `record_rake` RPC. It was outside the scope of
the 2026-07-24 rake audit and of today's. If it still serves real games it is an
unaudited money path, and a second writer of rake records.

**Do:** determine whether any live route reaches it. If yes, audit its rake/BBJ
math against the canonical schedule. If no, delete it — same reasoning as
`RakeService` (deleted today): a dead-but-plausible money path invites revival.

**Done when:** either audited and documented, or removed.

---

## P1-3. Triage the unit suite — 45 of 162 files are red

**Why:** `npx vitest run` in club-arena: **45 failed / 117 passed** files, 38
failed tests. Failures span `Button`, `Modal`, `GlobalHeader`, `ErrorBoundary`,
`cashier-flows`, `credit-request-flows`, `tournament-flows`,
`AchievementService`, `mapEngineSnapshot`. This predates today's work (verified:
zero failures reference anything I changed).

A suite this red provides no signal — nobody can tell a new break from the
existing noise, which is how the `main`-was-red typecheck bug survived.

**Do:** bucket the 45 by cause (stale mocks / changed component APIs / real
regressions). Fix or quarantine with an explicit `.skip` and a linked issue.
Target: green, or a documented allowlist that CI enforces does not grow.

**Done when:** `vitest run` exits 0, or every remaining failure is deliberately
quarantined.

---

## P1-4. Finish U5.3 — 53MB of probable duplicate-format assets

**Why:** I removed 20MB today (25 unreferenced club-logo PNGs duplicating the
WEBPs the code uses). `public/hub/club-arena/` went 104MB → 85MB. The same
pattern very likely continues:

cards/ 26MB 60 basenames exist in more than one format
images/ 26MB 61 basenames exist in more than one format
game-card-icons/ 8MB 50 png + manifest.json

**Read this before touching it.** My first pass sampled literal filenames and
reported `cards` as 0/25 referenced — which would have implied 27MB of dead
files. **That was wrong.** Cards are referenced through constructed paths
(`/cards/backs/${id}.webp`, `ICON_BASE = '/game-card-icons/'`). Deleting on that
signal would have broken every card back on the table.

**Do:** write a real reference resolver that understands dynamic construction —
resolve base-path constants, template literals, and `manifest.json` entries —
then report unreferenced bytes per directory. Delete only what the resolver
proves unreachable, and verify the live URLs afterwards as I did for club-logos
(referenced asset → 200, deleted asset → 404).

**Note:** no Cloudflare/R2 credentials exist anywhere (13 env files, wrangler
config, keychain all clean; R2 appears only in `docs/PHASE-1.8-R2-MIGRATION.md`).
Do NOT provision R2. If anything genuinely needs off-repo hosting, use Supabase
Storage — 22 public buckets already exist including `club-logos`, `assets`,
`images`, `media`, and `SUPABASE_SERVICE_ROLE_KEY` is available. That keeps
RULE 12 satisfied (no new infra).

**Done when:** proven-dead assets removed, live URLs verified, size reported.

---

## P2-1. The arena pre-commit guard blocks merge resolutions

**Why:** the hook rejects any commit touching `public/hub/club-arena/` unless
`ARENA_BUILD=1` is set. That correctly stops hand-edited build output, but it
also blocks **merge-conflict resolutions** in that directory. The retired
World Hub bundle-copy path could not perform a merge. Today this forced a manual
`ARENA_BUILD=1 git commit` to land a merge of 308 generated files.

**Do:** exempt the merge case — if `.git/MERGE_HEAD` exists, allow the commit.

---

## P2-2. Time-bank config mismatch and missing types

**Why:** the server defaults `maxUses = 120` (VIP monthly) while the client
seeds `4`. Separately, `time_bank_remaining` and `time_bank_uses_remaining` are
absent from `src/types/database.types.ts`, which is why `TablePage.tsx:3274`
casts through `as any`.

**Do:** reconcile which number is correct with Dan, then regenerate
`database.types.ts` from the live schema and drop the casts.

---

## P2-3. Close the remaining plan phases

- **U3.4** — `server/src/index.ts` is 133 lines against a ≤100 target.
- **U6** — archive superseded docs (`POKERBROS_UPGRADE_PLAN.md`,
  `PHASE_3/4_*_PLAN.md`, `MASTER_BLUEPRINT.md`) with a README saying which doc
  supersedes each. Several still read as authoritative.
- **`news-digest.yml`** — the time-boxed CI cron exception. It only calls
  `/api/news/digest` over HTTP with `CRON_SECRET`, so it belongs on Open Claw.
  Steps exist in `.agent/handoffs/2026-08-13-migrate-news-digest-to-openclaw.md`.
  Remove it from the CLAUDE.md §11.4 allowlist and the CHECK 6c allowlist in the
  same PR.

---

## Working notes for whoever picks this up

- **Do not run git write commands from a Cowork sandbox VM.** The mount cannot
  unlink: `git stash pop` reports success and writes nothing, and `git commit`
  strands a `.git/index.lock` that then blocks git on the Mac host. Use the host
  terminal. Clear a stranded lock with `mv`, not `rm`.
- **A stranded `.git/rebase-merge`** silently reverted an edit and made
  `git commit --amend` a no-op today. Check for it when git behaves oddly.
- **Both repos are high-churn.** Multiple agents commit concurrently. `git log
--oneline -5` and file mtimes before editing `TablePage.tsx` (7,100 lines) or
  anything in `public/hub/club-arena/`.
- **The old CA-to-World-Hub sync loop is retired.** This historical note once
  described an automatic bundle-copy path that also produced 34 merge conflicts
  when invoked manually. Club Arena now publishes only through its reviewed,
  immutable Hetzner release workflow.
- **Verify deploys behaviourally.** `engine.smarter.poker/health` is
  cache-frozen. For engine changes, look for the restart signature in Supabase:
  a cluster of `tables.updated_at` in one minute (22 tables in a minute today).
