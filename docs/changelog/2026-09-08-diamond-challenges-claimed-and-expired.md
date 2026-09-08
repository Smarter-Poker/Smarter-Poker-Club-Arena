# 2026-09-08 - Daily challenges: claimed for horses, expired at seven days, and the horse fleet put back in the ledger

Continues `docs/changelog/2026-09-08-diamond-rules-wired.md`. Ruling 3 of `docs/DIAMOND-RULINGS.md`, amended here with the reason measured. Everything below was observed by query or by a rolled-back probe between 02:20 and 03:20 UTC.

## 1. What was true before

`user_daily_challenges` held **40,797 completed and unclaimed rows worth 2,410,529 diamonds** (40,749 of them a horse's) against a supply of 1,023,527. Nothing had ever claimed for a horse - 0 rows in `diamond_user_daily_awards` for the `daily_challenges` engine, ever - and nothing expired for anyone, so the promise only grew.

## 2. What changed (migration `20260908024742`, applied and registered)

- **A horse's completed challenge is claimed by the engine**, inside the transaction that completed it, through `claim_daily_challenge_serialized_body` - the same body a human's click reaches, with the same journal row, the same seven-day window, the same per-user daily cap. A failing claim files `CH3:horse_claim_failed` and never breaks the progress just recorded (CLAUDE.md 10.5: the engine supplies the input device a horse does not have).
- **Seven days to claim, for everyone.** Both claim paths refuse an expired reward with `P0430`, by the clock, so the rule holds whether or not the stamp has run. `expired_at` is the stamp the dashboard reads; `fn_expire_daily_challenge_rewards` sets it at 00:07 UTC. That job pays nothing and repairs nothing - it stamps what the clock already decided, which is why it is not the band-aid CLAUDE.md 10.12 forbids.
- **The backlog**: 4,703 rows completed more than seven days ago were expired at apply time. Rows inside the window keep the rest of it. Nothing was claimed retroactively.
- **A horse is never a certification fixture.** See section 3.
- The `daily_challenges` line is **12,000,000 a month**, from the measurement in section 4.

## 3. The defect the probe found: 468 horses were being treated as fixtures

The probe's first real horse claim credited the player correctly and then recorded **nothing** in the earn ledger. The cause: `fn_ca_is_fixture_account` matched **468 of the 1,000 live horses**, because an earlier sweep had tagged two whole horse generations into `ca_cert_accounts` - "Horse fleet generation of 2026-09-01" (416 rows) and "zero-UUID seeded bot profile" (52 rows). Every one of those horses was therefore skipped by the earn ledger, left out of the promotional budgets, and had its incidents downgraded to info: an `is_horse`-shaped exclusion wearing a different name, which is exactly what CLAUDE.md 10.5 exists to forbid, and a direct contradiction of the ruling that promised in writing that this predicate "never matches a horse".

Fixed at the root (10.11): the predicate now asks the profile, so no future tagging can exclude a horse again, and the mis-tagged rows are deactivated with their reason preserved. `ca_cert_accounts` active rows went 519 -> 51, which is the real harness. The law that guarded this pinned it as `expect(fixture).not.toContain('is_horse')` - the wrong shape, and the reason nobody saw it for a day; the pin now asserts the guarantee itself, on the newest definition rather than the first.

## 4. Ruling 3 amended: the limits govern the claim, not the assignment

Ruling 3 said a challenge is "capped at assignment" by the `daily_challenges` line. A shared pot is a **race**: with 36,176 rows outstanding inside the window, the September line was already **516,919 in deficit**, so an assignment cap would have set every player's next challenge to zero diamonds for the rest of the month, and whoever arrived later would get less. That is not identical treatment. The cap belongs where the money moves and it is already there: the earn ledger measures every claim against the per-user daily cap (800 for `daily_challenges`, identical for everyone) and against the monthly line, and `20260908021452` made both refusable behind `ca_diamond_rule_modes`. A challenge now pays what the catalog promised; the claim is what the limits govern.

**The consequence, stated plainly for Dan.** With horses claiming, the line carries the whole playing population. Measured over the three prior days: 4,945 to 8,183 rows assigned a day, 84,000 to 460,000 diamonds of reward a day, 95 to 471 per player per day on average with a maximum of 1,646. The line is therefore 12,000,000 a month (about 400,000 a day, above the measured peak), not the 50,000 ruling 18 wrote when nothing claimed at all. This is a real increase in issuance - it is what "horses are players" costs, and horse diamonds stay inside the platform (ruling 9). If the aggregate should be smaller, the lever is the per-user daily cap in `diamond_engine_daily_caps`, which is identical for horses and humans and is Dan's row to change.

## 5. The probe (one transaction, rolled back by its final RAISE)

```
PROBE OK (rolled back):
0 fixtures: no horse matches the fixture predicate.
1 horse e8cca6bc: claimed 1 challenge rows worth 42 in one transaction (1 claim journal rows);
  balance moved 192, equal to every journal row this transaction wrote.
2 expiry: P0430 from both claim paths.
3 assignment pays the catalog in full (70), and the earn ledger counted 42 for this horse today
  against the 800 cap.
```

The balance moving by 192 while the challenge paid 42 is correct and is why the probe asserts the _journal_, not the reward: claiming a challenge can complete a streak milestone, which credits on the same trigger chain. The invariant that matters is that every diamond that moved was journaled.

## 6. Three traps this migration paid for, recorded so the next one does not

1. **`DROP TRIGGER` on `user_daily_challenges` demands ACCESS EXCLUSIVE on `auth.users`** (the table carries FK constraint triggers to it), and `auth.users` is touched by every authenticated request. It deadlocked three times. A guarded `CREATE TRIGGER` needs only the table lock the transaction already holds.
2. **Take every table lock in one statement, first.** A draft that also altered `diamond_reward_budgets` deadlocked against live claims, which hold `user_daily_challenges` and then read the budgets - the opposite order.
3. **The dashboard-revision trigger is switched off for the one mass stamp.** Its 4,703 per-row inserts take KEY SHARE locks on `profiles` while this transaction holds the table. A stale revision costs one refresh; the daily stamp runs with the trigger on and takes no table lock.

## 7. Verified after apply

`fn_ca_mint_supply('diamonds')` 1,024,027 = `SUM(profiles.diamonds)` 1,024,027; 4,703 rows carry `expired_at`; 0 horses match the fixture predicate; `ca_cert_accounts` active 51; `daily-missions-reward-expiry` scheduled at `7 0 * * *`; the law files and the registry green (281 tests).
