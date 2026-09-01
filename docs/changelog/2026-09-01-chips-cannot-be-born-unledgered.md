# Chips cannot be born unledgered

2026-09-01 12:05 UTC, `fn_ca_supply_snapshot` raised a critical: total chip
supply rose **4,159,902.13** in one hourly interval beyond anything the ledger
had issued, same sign as the interval before it, which is the shape of a leak
rather than an oscillation.

It was not a leak. It was a restore, and the ledger simply did not see it.

## What happened

At 11:00:37 migration `20260902050000_user_clubs_are_human_only` deleted the
416 Deep Stack Society memberships. That was ledgered correctly, because
`club_members` has an `AFTER DELETE` ledger trigger: `chip_ledger` 70eba2a1,
4,159,644.00 out of `player_wallet` and into `chip_retirement`.

Between 11:05 and 11:20 the same rows were restored from
`club_financial_quarantine` and re-**INSERTED**, each still carrying the
`chip_balance` it held when it was quarantined. Nothing recorded that at all.

So for an hour the books said those chips were retired while they were sitting
in wallets, and the platform's own supply watcher was the only thing that
noticed.

## Why an INSERT can carry a balance

`fn_membership_starts_with_zero_chips` zeroes the opening balance on any new
membership — unless the row is a bot or the profile is a horse, in which case
it returns `NEW` untouched. That exemption is what makes fleet provisioning and
quarantine restores possible, so it stays. What it lets through is now recorded.

## The measurement

Every balance-bearing table, by which arm of the trigger set it carries:

| table            | ledgers INSERT | ledgers DELETE |
| ---------------- | -------------- | -------------- |
| clubs            | yes            | yes            |
| club_wallets     | yes            | yes            |
| union_wallets    | yes            | yes            |
| bbj_pools        | yes            | yes            |
| spin_bonus_pools | yes            | yes            |
| **club_members** | **no**         | yes            |
| **agents**       | **no**         | yes            |
| **unions**       | **no**         | yes            |

Five of eight ledger both ends. Three ledger the exit and not the entrance.
`club_members` is the one that fired. `agents` is the one that fires next: the
pending rebuild of the 32 Deep Stack agent rows carries **3,340,000** in
`agent_wallet_balance` and would have minted every chip of it the same way.

## The change

`fn_ca_autoledger` already handles `TG_OP = 'INSERT'` — the other five tables
use it on INSERT today. The three missing tables now get the same trigger, with
the same column-to-account specs their own DELETE triggers already use.

It cannot break provisioning: `fn_ca_autoledger` never raises. It falls back to
`settlement_suspense`, and then to a row in `ca_ledger_write_failures`, so a
restore or a fleet build can never be refused by this change. The `WHEN` clauses
keep the ordinary case free — a human joining a club inserts with zero balances
and the trigger never fires.

Callers that know their counterparty should declare it first with
`fn_ca_declare_ledger('mint','issuance_reserve')`. Undeclared writes land on
`settlement_suspense`, which is visible and gated, instead of nowhere, which is
not.

`fn_ca_unledgered_insert_paths()` is the standing detector: any table that
ledgers a balance out on DELETE and not in on INSERT comes back from it. It must
return zero rows, and the migration asserts that on its way in.

## Verified before it was applied

The trigger and an insert of 1234.56 for a horse were run inside a `DO` block
that ends in `RAISE EXCEPTION`, so the whole thing rolled back (CLAUDE.md 11.5 —
never spend real chips to test a rule). It posted:

    issuance_reserve -> player_wallet  amt=1234.56  cat=mint
    "auto-ledgered club_members.chip_balance delta 1234.56"

and left nothing behind: membership count still 417, zero ledger rows, zero
probe triggers.

## The correction, and a second bug found posting it

The 4,159,644.00 already in the wallets was corrected through
`fn_ca_post_correction` — ledger-only, no balance touched — as
`chip_retirement -> player_wallet`, linked to incident b689bbb6, reversing the
part of 70eba2a1 that the restore had undone.

The first attempt failed. `fn_ca_post_correction` ends by appending an incident
event of kind `'commented'`, and `ca_incident_events_kind_check` does not allow
that value; `'comment'` and `'repair_action'` are the near ones. Every
incident-linked correction ever attempted aborted on that last INSERT and rolled
the correction back with it — the platform's only compliant correction path had
never been able to commit. Fixed in
`20260901121902_the_correction_path_could_never_post.sql`.

With the correction posted, `fn_ca_auto_reconcile_tick` re-read the interval on
its own and the 12:05 snapshot now reports **258.13** unexplained — ordinary
play, in line with the ±30 to ±950 of every other interval that day.

The remaining 4 open board items are unrelated (a self-clearing suspense-flow
notice from the provisioning window, and four historical tournaments that
settled without dealing a hand).
