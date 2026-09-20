# The Diamond Arena record is current

2026-09-20. Workstream E items E3, E6 and E11, plus the owner runbook. No production database write was made by this work, and no arena switch was touched.

## What was wrong

**The record disagreed with the database, and in the direction that misleads.** Between September 14 and September 20 the Diamond Arena's migrations went live, were archived out of `main` by the September 16 restore, and came back through #4941; the engine and client came back through #4938 and #4947. Through all of it the programme still carried a sentence saying the Phase 8 and Phase 9 checklist lines "are shown unchecked until that code is back on `main`", while the lines themselves were ticked. A reader had to guess which half was current.

**A written law contradicted a written ruling.** `tests/law/DiamondTransfersAreOffAndAGiftIsOneTransaction.law.test.ts` asserted that player-to-player diamond transfers are off. That was true for one day. Dan amended ruling 4 on 2026-09-08 to allow them through one atomic, authenticated, journaled path, migration 20260909200327 built exactly that door the next day, and Phase 4 of the build programme requires it. The law and the ruling had been in conflict ever since, which under CLAUDE.md 10.8 is a coin flip decided by whichever the next agent reads first.

**A CI allowlist named a table that has never existed.** `scripts/ci/check-realtime-publication.mjs` carried `diamond_arena_scores` with the reason "unresolved: scores page subscribes and receives nothing". The page was deleted on 2026-09-09 and the table was dropped by `20260314_drop_orphan_tables.sql` long before that. Nothing subscribed, nothing could.

**Ruling 17's status said "Roadmap Phase 1 and 2"** while five of its rules had already armed themselves.

**There was no compatibility record.** Nothing said how far back the engine or client could roll before a funded Diamond seat became unreachable, and nothing wrote down that the client rollback budget is ten releases.

## What changed

`docs/dr/diamond-release-manifest.md` is new. It lists the Diamond migrations that are live, read from production; which client or engine SHA introduced each caller, from `git log -S`; what `scripts/ci/check-engine-doors-exist.mjs` covers and what it does not (it scans `server/src` only, so the client is not covered, and it has three outcomes rather than two); the minimum compatible SHAs, `86aab0e6` for the Phase 6 cutover and `ab9e626376` for the tournament boundary; the forward-only database rule and why a Diamond migration is never reverted; the custody-outstanding rollback rule; the ten-release client budget at `publish-club-arena.yml:666`; and the 285-second engine cutover reserve at `engine-release-transaction.sh:42`, `:43` and `:50`.

`docs/runbooks/diamond-launch-owner-steps-2026-09-20.md` is new. It sets out, in order, the production actions this session could not perform: the two gate-branch migrations and the branch push, the two F06 migrations already on `main` that are prerequisites of any engine activation, the engine activation decision with its full diagnosis, and the two arena switches that no agent flips. Each step carries its file path, its `apply_migration` name and version, the readback SQL and the conditions under which the owner stops.

`scripts/ci/check-realtime-publication.mjs` loses the `diamond_arena_scores` entry. Verified before removing it: the table does not exist in `information_schema.tables`, it is not in the `supabase_realtime` publication, and the only remaining references anywhere in the repository are two historical audit documents describing it as already gone. The script's own logic consults the allowlist only for tables a client actually subscribes to, so the entry could never fire.

`docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md` gains an Execution Update dated September 19 to 20 recording what merged (#4938, #4941, #4945, #4946, #4947), why the engine build carrying the Phase 8 and 9 boundary is staged and not active, the two migrations awaiting owner installation, and that both arena switches stay off. The stale "shown unchecked" sentence is retired. The Phase 8 lines and the Phase 9 bounty line are confirmed rather than re-ticked, because they were already ticked and the check was to prove they had earned it.

`docs/DIAMOND-ACCOUNTING-ROADMAP.md` gains section 0g: the five rule flips of September 15 and 16 with their timestamps and the reason each remaining rule has not armed, the clean-day streak with the evidence that it is a measured streak rather than a gap in measurement, and the open critical incidents with the named migration that resolves each. Its Diamond Arena accounting scorecard row moves from DOES NOT MEET to PARTIAL.

`docs/DIAMOND-RULINGS.md` ruling 17's status now says what is armed and what is not.

The transfers law is retargeted and renamed to `tests/law/DiamondTransfersGoThroughOneDoorAndAGiftIsOneTransaction.law.test.ts`, with its `docs/laws.d/` entry renamed to match.

## How the law was retargeted, and what was deliberately not pinned

The old law had four groups of assertions and only one of them was wrong. The gift atomicity pins and the anti-farming ladder pins are true of migration 20260908031918 and are kept verbatim; every one of them is a defect that was live on 2026-09-08 and removing them would lose that protection. The legacy `transfer_diamonds_deduct`/`transfer_diamonds_credit` pair is still dropped, so that pin is kept too.

What replaced the "transfers are off" group is what actually governs the door now, read out of `20260909200327_atomic_wallet_diamond_transfers.sql`: `send_wallet_diamond_transfer` is defined SECURITY DEFINER with `SET search_path = public, pg_temp`, is revoked from everyone and granted to `authenticated` alone, writes an append-only `diamond_wallet_transfers` row naming both sides and both journal legs, and exposes that row only to the two participants. A second group pins that the retired doors stay retired: `fn_arena_deposit` and `fn_arena_withdraw` raise rather than move money, from `20260909065458_poker_diamond_custody.sql`, because custody replaced them.

One fact is documented in the test header and the registry entry rather than pinned. `fn_guard_profile_privileged_columns` does not name the transfer route, so every attempt answers 42501 at the first wallet UPDATE and rolls back, which is why `diamond_wallet_transfers` holds zero rows. Read in production on 2026-09-20: the guard body names `send_stream_gift`, `fn_arena_deposit` and `fn_arena_withdraw`, and not `send_wallet_diamond_transfer`. The one-line admission is migration `20260919223115`, which is not on `main` and not applied, and a law may not assert a file that is not there. Pinning it would have made this test red on `main` for a reason that has nothing to do with the law.

## How it was verified

Every production fact in the three documents was read with `mcp__Supabase__execute_sql` against project `kuklfnapbkmacvwxktbh`, read-only, on 2026-09-20, and nothing was written. `supabase_migrations.schema_migrations` confirmed which Diamond migrations are live and that `20260918232558` and `20260919024039` are not. `pg_proc` confirmed that the five `fn_f06_*_mixed_manager_custody` functions `server/src/tournament/mixedF06Custody.ts` calls do not exist, which is what the engine door gate is refusing, and that the profile guard does not name the transfer route. `engine_tournament_leases` confirmed zero rows for tournaments `5a387a75` and `615783bf`, so the legacy checkpoint's preconditions genuinely do not exist and must not be fabricated. `smarter_private.f06_hand_permits` gave 697 reserved permits across 470 running tournaments. `https://engine.smarter.poker/health` gave `releaseSha` `8825af51817f379c4261658ca29ecc9d8d81932d`, instance `1-3846b8bb`, `readyForRestart` false with `unparkedReasons` `{"f06_preparation_unresolved": 1}`.

The retargeted law and the law registry both pass. `node scripts/ci/check-realtime-publication.mjs` exits 2, "COULD NOT ASK", with no database URL in the local environment, which is the outcome it is built to give rather than a pass; it runs with a URL in `production-integrity-audit.yml`.

Every line number cited in the manifest was read out of the file it names before it was written down.
