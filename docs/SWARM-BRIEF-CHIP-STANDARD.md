# SWARM BRIEF - Chip Accounting Standard implementation (2026-09-02)

> Historical lane brief. Current release authority is `.github/DEPLOYMENT.md`.
> Never scrape a workstation `.env`, call a deployment API directly, or use
> this dated brief as a credential or publishing runbook.

You are one lane of a swarm implementing `docs/CHIP-ACCOUNTING-STANDARD.md` (read it first; it is in your worktree at that path). Your lane, worktree and deliverables are in your task prompt. This file is the shared operating contract.

## Environment - you are on Dan's Mac

- Use `mcp__counselors__host_terminal` for every shell command. `node` is NOT on PATH: prefix commands with
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`.
- Your worktree is already created on branch `fix/chip-std-<lane>` from `origin/main` and is connected for Read/Write/Edit/Grep/Glob. Never touch another lane's worktree or `~/Documents/club-arena` (the main clone).
- Supabase production: project `kuklfnapbkmacvwxktbh`. Read with `mcp__527a2e75-ebb7-44df-9538-92d3a9619012__execute_sql`. Apply DDL ONLY with `mcp__527a2e75-ebb7-44df-9538-92d3a9619012__apply_migration` (name = your migration file name without `.sql`). The repo mirror of money functions is stale in places; **read the live body from `pg_proc.prosrc` before you replace a function**, and keep every behaviour you did not set out to change.
- GitHub: use the configured `gh` credential store. Push the branch normally;
  the branch-proposal signal and trusted default-branch opener create the PR.
  Local env files are never repository or release authority.

## Binding rules (CLAUDE.md, enforced by hooks and CI)

1. **DDL: one migration file, one transaction (BEGIN/COMMIT), applied ONCE.** Every DDL statement triggers a ~28s PostgREST reload. No retry loops. No DDL probes. If apply fails, read the error, fix the file, apply once more.
2. **Never spend real chips to test a rule.** Probe money functions inside a transaction you ROLL BACK (`scripts/dev/probe-rpc.sql` is the pattern; helpers in `pg_temp`). Never DELETE `table_seats`. Never credit a real wallet to "see if it works".
3. **Horses are players** (CLAUDE.md 10.5). Never write `is_horse` to exclude a horse from anything a human gets.
4. **Never push a red test.** Run the tests that cover what you touched (`npx vitest run <paths>` in the repo root for client/tests; `cd server && npx vitest run <paths>` for engine) and `npx tsc --noEmit` (both roots) before pushing. Write the spec first if you like, but `.skip` it until the implementation lands in the same commit.
5. **Every `*.law.test.ts` needs a row in `docs/LAWS.md`.** `tests/law-registry.law.test.ts` enforces it. Negative-control every pin: mutate the source, confirm it goes red, restore.
6. **Write your own changelog**: `docs/changelog/2026-09-02-chip-std-<lane>.md`. Never append to `MIGRATION-CHANGELOG.md`.
7. **Declare new schema in `scripts/ci/schema-manifest.d/<lane>.json`** (see that directory's README). Never hand-edit `scripts/ci/supabase-schema-manifest.json` or `supabase-columns-manifest.json`.
8. **New tables: `REVOKE ALL FROM anon, authenticated`; enable RLS; grants to `service_role` only** unless the browser must read it. New money RPCs: `SECURITY DEFINER`, `SET search_path = public`, register in `ca_money_rpc_registry` if they write a balance column, and run `node scripts/ci/check-definer-authorization.mjs` if present.
9. **No emoji in source. No em dashes (U+2014) in any player-facing string.** Popups go through the Toast layer.
10. **Commit author must be** `Smarter-Poker <254329056+Smarter-Poker@users.noreply.github.com>` (`git -c user.name=Smarter-Poker -c user.email=254329056+Smarter-Poker@users.noreply.github.com commit ...`).
11. **Never rebase.** If main moved, `git merge origin/main`. Resolve `docs/LAWS.md` conflicts by union (keep both sides' rows).
12. **Never `--no-verify`.** The pre-push hook takes ~3 minutes: launch the push as `nohup git push -u origin <branch> > /tmp/push-<lane>.log 2>&1 < /dev/null & disown`, return, and poll the log in later calls.
13. **Do not wait on CI.** Open the PR, report its number, stop. One final status check is fine; a loop is not.
14. **Do not move money by migration.** If your lane finds money owed to players, write the obligation rows (Lane A's `tournament_obligations`) or an incident; do not credit wallets from a migration. Today's double payments came from exactly that.

## Definition of done for every lane

- Migration applied to production (confirm via `list_migrations`) with post-apply assertions that ran green.
- Rolled-back probe transcript pasted in the PR body for every new money path (what was refused and why).
- Tests: touched-area vitest green, `tsc` clean in both roots, law test with negative control, `docs/LAWS.md` row.
- Changelog file written with what was observed, not what was intended.
- PR opened against `main` with title `fix(chip-std): <lane> - <one line>`; body contains the probe transcript, the test output, and the migration name.
- Final message to the orchestrator: PR number, migration name, anything you could not finish and why, and any decision that is Dan's.

## Shared interface (so lanes do not collide)

Lane A owns these names; other lanes call them but do not define them:

```sql
-- tournament_escrow: one row per tournament, all columns numeric(15,2) CHECK (>= 0)
--   tournament_id uuid PK, prize_balance, bounty_balance, fee_balance, updated_at
-- tournament_obligations: what a tournament owes, who has been paid
--   id uuid PK, tournament_id uuid, kind text CHECK (kind in
--     ('place','bounty','bounty_residual','mystery_bounty','refund','seat','satellite_remainder',
--      'bubble_protection','final_table_deal','late_reg_adjustment')),
--   place int NULL, user_id uuid NULL, amount_owed numeric(15,2), amount_paid numeric(15,2) default 0
--     CHECK (amount_paid <= amount_owed), source text, created_at, settled_at
--   UNIQUE (tournament_id, kind, place) WHERE place IS NOT NULL
--   UNIQUE (tournament_id, kind, user_id) WHERE place IS NULL
-- fn_settle_tournament_obligation(p_tournament_id uuid, p_kind text, p_place int, p_user_id uuid,
--     p_amount numeric, p_source text, p_description text DEFAULT NULL, p_adjustment_id uuid DEFAULT NULL)
--   RETURNS jsonb {ok, paid, already_paid, refused_reason, obligation_id, idempotency_key}
--   Upserts the obligation (owed = max(owed, amount) never lowers), pays min(amount, owed - paid) from
--   tournament_escrow.<prize|bounty> to club_members.chip_balance, writes tournament_payouts +
--   wallet_transactions under key 'obl:<obligation_id>:<n>', sets app.money_path='fn_settle_tournament_obligation'.
--   Refuses (ok=false) when escrow cannot cover it. Never raises for a replay.
```

Lane A2 (engine) codes against that signature. Until Lane A's migration is applied, A2's tests mock the RPC.
