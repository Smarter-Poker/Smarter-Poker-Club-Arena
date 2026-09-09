# 2026-09-09 - daily bonus build-out, phase 1 of 8: integrity and the ledger

Dan, 2026-09-09: build out everything on the post-audit to-do list (#4026) in
phases. Phase 1 is the part of the bonus that keeps books on itself.

## Built

- **Refusal log.** `ca_daily_bonus_refusals`, one row per refused claim with
  reason, the ledger's detail and where it came from. Every refusal path in
  `fn_ca_daily_bonus_claim` goes through `fn_ca_daily_bonus_refuse`; the
  migration asserts no bare refusal survives in the body. Append-only.
- **Where a claim came from.** `ca_daily_bonus_claims.claimed_from`:
  `device_id` and `platform` sent by the client (`src/lib/installId.ts`, the
  same install id the push subscription already mints, so the two never
  disagree about what a device is), plus `ua` and `ip_class` the server reads
  from the request headers. The IP is kept as a /24 or /48 class, never whole.
- **Velocity rule.** Three or more accounts claiming from one install id in a
  day, or six from one network class, file a `financial_alerts` warning
  (`fn_ca_daily_bonus_claim.device_velocity` / `.ip_velocity`), once per
  device per day, inline in the claim. Nothing is refused; the alert names
  the accounts.
- **Budget anomaly rule.** A day whose bonus diamonds exceed the 95th
  percentile of the previous 14 days (minimum seven days of history) files
  `fn_ca_daily_bonus_claim.budget_anomaly`, once per day. Read from
  `diamond_user_daily_awards`, so no journal scan on the claim path.
- **Economy lines repaired.** `diamond_reward_budgets (2026-10,
club_arena_daily)` was NULL and would have been copied forward; it now
  carries September's 10,000. The four bonus journals paid before the
  ruling-21 trigger rewrite now have their `ca_diamond_engine_spend` rows.

Migration `20260909212512_the_daily_bonus_keeps_its_own_books` (applied to
production). The claim gained `p_client jsonb DEFAULT NULL`; one body, DROP
and CREATE.

## Not built, and why

- "Split the read path from `open_day` so a status read is not a write": on
  reading the function again, `fn_ca_daily_bonus_open_day` returns before any
  write once the day row exists, so only the first read of a day writes. The
  item was overstated in the audit and is closed without a change.

## Verification

- Rolled-back production probe: a claim naming yesterday writes a refusal row
  with `reason = day_rolled_over` and `claimed_from = {device_id, platform,
ua, ip_class 203.0.113.x}`; three accounts claiming from `probe-device-1`
  produce exactly one `device_velocity` alert; the budget rule stays quiet
  with two days of history. All rows gone after the probe.
- Tests: `dailyBonusLedger.law.test.ts` pins the migration (no bare refusal,
  both rules called, IP masked, fragment declared); `installId.test.ts`;
  `DailyBonusService.test.ts` pins `p_client` = install id + platform and
  nothing else. 60 tests across the seven files that cover the change.
