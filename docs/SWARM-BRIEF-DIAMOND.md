# SWARM BRIEF - Diamond Economy audit, standard and fixes (2026-09-02, ~23:00 UTC)

> Historical lane brief. Current release authority is `.github/DEPLOYMENT.md`.
> Never scrape a workstation `.env`, call a deployment API directly, or use
> this dated brief as a credential or publishing runbook.

You are one lane of a swarm auditing and then fixing the DIAMOND economy of Smarter Poker / Club Arena, from the Mint to the players and everything in between, and preparing the ground for the Diamond Arena (one platform club where everyone plays cash, MTTs, spins, SNGs and satellites in diamonds). This replicates, 1:1, the chip work of 2026-09-02: `docs/CHIP-ACCOUNTING-STANDARD.md`, `docs/CHIP-ACCOUNTING-ROADMAP.md`, `docs/audits/2026-09-02-chip-standard-round2/`. Your lane, worktree and deliverables are in your task prompt. This file is the shared operating contract. Everything in `docs/SWARM-BRIEF-CHIP-STANDARD.md` still holds except the names below.

## Environment - you are on Dan's Mac through MCP tools

- Shell: `mcp__counselors__host_terminal` runs real bash on Dan's Mac. `node` is NOT on PATH: prefix with `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`. Each call has a ~60s limit: launch anything slow with `nohup ... > /tmp/<lane>.log 2>&1 < /dev/null & disown` and poll the log. If the tool says the device did not respond, wait and retry once.
- Read-only audit lanes write ONLY under `docs/audits/2026-09-02-diamond-economy/` in the orchestrator's worktree `/Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-audit` and never run git there. Fix lanes get their own worktree on branch `fix/diamond-<lane>`: `cd /Users/smarter.poker/Documents/club-arena && nohup git worktree add -b fix/diamond-<lane> /Users/smarter.poker/Documents/.agent-trees/club-arena/diamond-<lane> origin/main > /tmp/wt-<lane>.log 2>&1 < /dev/null & disown`, then `ln -s /Users/smarter.poker/Documents/club-arena/node_modules node_modules`. Never touch another lane's worktree or the main clone.
- Supabase production: project `kuklfnapbkmacvwxktbh` (Postgres 17). Read with the `execute_sql` tool of the Supabase MCP (in this session it is named `mcp__b6d9edd4-a2e3-495f-b4c4-16c2befba6ef__execute_sql`; load it with ToolSearch `select:` if deferred). Apply DDL ONLY with `..._apply_migration` (name = migration file name without `.sql`). `execute_sql` returns the last SELECT of a multi-statement script even when it ends in ROLLBACK: `BEGIN; ...probe...; SELECT ...; ROLLBACK;` is the probe shape. Regex `{n,m}` fails in this client: use unbounded quantifiers or substr/position; `\b` is backspace, use `\y`. The client times out at 60s but the transaction may have committed: verify before re-applying.
- **Read the LIVE body before you replace a function**: `select pg_get_functiondef(oid) from pg_proc where proname='...'`. The repo mirror is stale in places. Keep every behaviour you did not set out to change and prove it (compare reconstructed body length to `length(prosrc)`).
- GitHub: use the configured `gh` credential store. Push the branch normally;
  the branch-proposal signal and trusted default-branch opener create the PR.
  Local env files are never repository or release authority.
- Engine (`server/`) publishes only through the Club Arena-owned exact-SHA
  Hetzner workflow. Immediately dispatch already-staged work toward the current
  certified break through the owning lane; never force or restart it by hand.

## Binding rules (Dan's, enforced by hooks and CI)

1. **DDL: one migration file, one transaction (BEGIN/COMMIT), applied ONCE.** Every DDL statement triggers a ~28s PostgREST reload; a burst caused a live winner-credit failure on 2026-09-02. No retry loops. No DDL probes, not even inside a rolled-back transaction. If apply fails, read the error, fix the file, apply once more. One migration per lane; a trigger on a hot table (`profiles`) gets its own migration with `SET LOCAL lock_timeout = '4s'`.
2. **Never spend real diamonds to test a rule.** Probe inside a transaction you ROLL BACK. Never credit a real balance "to see if it works". **Never move diamonds by migration** (no back-pay, no clawback): write obligations or incidents.
3. **Horses are players** (CLAUDE.md 10.5). Never exclude a horse from anything a human gets.
4. **Never push a red test.** `npx vitest run <paths>` (root) / `cd server && npx vitest run <paths>`; `npx tsc --noEmit` in each root you touched. `.skip` a spec until its implementation lands in the same commit.
5. **Every `*.law.test.ts` needs a row in `docs/LAWS.md`** (`tests/law-registry.law.test.ts` enforces it) with a negative control.
6. **Own changelog**: `docs/changelog/2026-09-<dd>-diamond-<lane>.md`. Never `MIGRATION-CHANGELOG.md`. Write what you OBSERVED (numbers, rolled-back probe transcripts), never intentions.
7. **Declare new schema** in `scripts/ci/schema-manifest.d/diamond-<lane>.json`. Never hand-edit the big manifests.
8. **New tables: `REVOKE ALL FROM anon, authenticated`; RLS on; `service_role` only** unless the browser must read. New money RPCs: `SECURITY DEFINER`, `SET search_path = public`, in-file REVOKE/GRANT stating who may call (pre-push `check-definer-authorization` reads the branch; the CI Telemetry Exposure job scans the LIVE database for unscoped definers a browser can execute), registered in `ca_money_rpc_registry` if it writes a balance.
9. **No emoji in source. No em dashes (U+2014) anywhere, docs included. Title Case in player-facing copy.**
10. **Commits**: `git -c user.name=Smarter-Poker -c user.email=254329056+Smarter-Poker@users.noreply.github.com commit ...`; end the message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and a `Claude-Session:` trailer. **Never `--no-verify`.** The pre-push hook takes ~3 minutes: push with `nohup git push -u origin <branch> > /tmp/push-<lane>.log 2>&1 < /dev/null & disown` and poll. Never rebase; `git merge origin/main`; `docs/LAWS.md` conflicts resolve by union.
11. **Do not wait on CI.** Open the PR, report its number, stop.
12. **Dan's risk rule (verbatim): "IF THERE ARE ANY THAT YOU CONSIDER HIGH RISK FOR DAMAGING CODE OR OTHER PAGES, DO NOT BUILD THEM."** Anything that could refuse a legitimate live movement, block a purchase or an earn, or change a hot-path result ships LOG-ONLY first (record the would-be refusal + info incident). If you judge an item high-risk, do not build it: write it under "Decisions that are Dan's".
13. **Report only what you verified.** Numbers from queries you ran; label the rest UNVERIFIED / UNKNOWN. Rolled-back probe transcripts go in the PR body and the changelog.

## The diamond economy as measured by the orchestrator (2026-09-02 ~22:50 UTC, CONFIRMED)

- Canonical store: `profiles.diamonds` (1,308 rows, 1,030,092 total, 0 negative). `profiles.diamond_balance` is a BEFORE trigger mirror (0 mismatches). `user_diamonds`, `user_diamond_balance` and `diamond_wallets` are AFTER-trigger mirrors since migration `the_mint_issuance_and_retirement` (17:29:15 UTC today): all three now equal profiles per row (416 of 416 wallets equal). `user_progress.diamonds` 10,700 (107 rows), `bot_profiles.diamonds` 26,541 (139 rows), `club_members.diamonds` / `club_memberships.diamonds` 0, `club_diamond_wallets` 0.00 (2 rows). Dead `public.wallets`: PLAYER 732,581,244.02, PROMO 10,700, BUSINESS 50.01.
- `ca_diamond_snapshots` still ADDS `wallet_diamonds` to `profile_diamonds` in `total`, so the 17:29 mirror backfill shows as `unexplained = 619,829` at 18:10 and the baseline is now double-counted. That is a snapshot-identity defect, not a mint.
- Journal `diamond_transactions`: 1,432 rows all-time, 570 in 30 days (488 of them `pvp_refund`), 45 `daily_login`, 7 `adjustment` (-13,680), 6 `chip_purchase`, 3 `chip_mint`. `diamond_ledger`: 0 rows (dead). `ca_mint_ledger`: 0 rows for any asset. `ca_diamond_balance_audit`: 603 rows, net +160,140. `diamond_purchases`: 3 rows, 300 diamonds, Stripe columns. `diamond_arena_events`: 0 rows. `diamond_platform_budget`: 3 periods, 7,500,000 budget, 2,493 spent.
- 40 functions reference a diamond balance store by name; the full list with grants is in `lane1`. `send_stream_gift`, `send_wallet_diamond_transfer`, `claim_daily_challenge(s)`, `ca_promo_vault_buy` are executable by `authenticated`.

## Definition of done for a fix lane

Migration applied (confirm in `supabase_migrations.schema_migrations`) with post-apply assertions green; rolled-back probe transcript for every money path touched; touched-area vitest green, tsc clean, law test with negative control and a `docs/LAWS.md` row; changelog from observation; PR titled `fix(diamond): <lane> - <one line>`; final message: PR number, migration names, what is log-only, what you did not build and why, decisions that are Dan's.

## The shared interface (live in production since 2026-09-03 00:07 UTC, migration `20260903000735_diamond_std_foundation`)

```
ca_diamond_house(id = 1, balance numeric(20,0) CHECK >= 0, updated_at)        the house account (DR14)
diamond_reward_budgets(period 'YYYY-MM', engine, budget_diamonds, spent_diamonds, PK (period, engine))   one line per earn engine (DR7)
ca_diamond_incidents(id, occurred_at, rule, severity info|warning|critical, user_id, amount, writer, db_role, app_name, detail jsonb, resolved_at)
fn_ca_diamond_incident(p_rule, p_severity, p_user_id, p_amount, p_writer, p_detail jsonb) RETURNS void   never raises; service_role only
diamond_transactions.counterparty text NULL, diamond_transactions.issuance_class text NULL
  issuance_class IN (purchased, promotional, earned, transferred, seeded, refund, spend, bridge, deletion, admin, arena, house, unknown)
```

Every log-only rule records the refusal it did not make with `fn_ca_diamond_incident('DR<n>:<slug>', 'warning', user, amount, '<function>', detail)`. Every new journal row a lane writes sets `counterparty` and `issuance_class`. Nothing in the foundation moves a balance. Declare your own schema in `scripts/ci/schema-manifest.d/diamond-<lane>.json`; the foundation is declared in `diamond-foundation.json`.
