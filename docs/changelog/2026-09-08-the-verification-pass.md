# 2026-09-08 - The verification pass, and the four things it found

A read-only reviewer went over the five migrations applied earlier tonight (`20260908021452`, `024742`, `031918`, `033824`, `034530`) against live production. Migration `20260908041432` fixes what it found; this is the record of both.

## 1. What the verification confirmed

- All five versions are in `schema_migrations` and every stored statement is **md5-identical** to its file on disk.
- All 32 functions those migrations define or patch exist live, one overload each. All **50 apply-time patches landed** with zero unpatched markers left behind, and all 13 newly created bodies are byte-identical to their migration files.
- The refusal machinery is genuinely wired, not declared and ignored: each `v_refuse` is set, tested and returned/raised at named line numbers.
- **The money identity is exact**: `fn_ca_mint_supply('diamonds')` = `sum(profiles.diamonds)` = 1,023,527, on two readings fifteen minutes apart.
- Every drop is complete with no caller left in either repo's `origin/main` or in any live function body. The `fn_purchase_time_banks` drop was correctly sequenced: the live bundle's `TablePage` chunk contains exactly one `rpc("fn_purchase_time_banks_v2"...)`.
- Grants are as specified; nothing touched tonight is `anon`-executable except the one case below.
- End to end: profile `PostDeploy54485`, created 04:01 UTC **after** the migrations, was born at 0 and holds 500 - the signup grant now comes from the Mint.
- The one CRITICAL incident (`DR11:trial_balance_break`, 223,580 at 03:20) is the 468 horse certification accounts moving out of the fixture set, which is the correction `20260908024742` made deliberately. The reviewer predicted the next detector run at a delta of exactly 0 and it was 0.

## 2. What it found, and what this migration does about it

**1. `DR15:cross_asset_seat` read as armed while nothing consumed it.** The rule row carried `flip_after 2026-09-22` and a clean-days requirement, but `fn_ca_arena_seat_is_same_asset` never called `fn_ca_diamond_rule_mode`. A flip on the 22nd would have reported `mode: refuse` and changed nothing - the precise shape CLAUDE.md 10.86 exists to forbid, in a codebase that has been bitten by it before. Fixed twice over, because either half alone leaves the trap for the next rule:

- the seat guard now **reads** its mode, and flipping DR15 escalates the incident from warning to critical. It still never refuses a seat: a guard that can refuse a seat can strand a player mid-hand;
- `fn_ca_diamond_rule_flip` now **refuses to flip a rule that no function consults**, and the migration asserts that no such rule exists.

**2. The trial balance called two deliberately dropped columns "unreadable"**, conflating "dropped as planned" with "my query broke" in the one line whose job is to tell those apart. It now checks for the column and says `dropped`.

**3. `player_diamonds.balance_now` counted the fixture harness while `balance_delta` excluded it**, so adding the player and fixture rows double-counted 10,900. `balance_now` is now the same population the delta measures, and the note says so.

**4. `fn_wheel_spin` was executable by `anon`.** It refuses a caller with no `auth.uid()`, so this was never exploitable, but a money path a signed-out visitor can call at all is defence-in-depth not worth spending. Revoked.

## 3. Recorded, not changed

- The daily expiry stamp runs at 00:07 UTC, so a completed challenge can sit unstamped for up to a day past seven. **Players are not affected**: both claim paths refuse by the clock at exactly seven days (`P0430`), and only the dashboard's stamp lags.
- Cron timeouts on `ca-stats-witness-audit-15m` and friends are chronic and pre-existing - more failures yesterday than tonight - and belong to whoever owns those jobs.
