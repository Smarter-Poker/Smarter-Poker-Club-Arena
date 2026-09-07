# 2026-09-07 - A profile is born with its diamond mirrors, and a mirror never invents a number

Phase 4, item one: "the 619,829 diamonds". **That number is closed and was
already closed.** It was a snapshot-identity defect - `ca_diamond_snapshots`
added the `diamond_wallets` mirror to `profiles.diamonds` and counted every
diamond twice - fixed on 2026-09-03 by the DR10 change that made
`v_total := v_prof`. Measured across the last twelve hourly snapshots:
`total = profile_diamonds` on every one, `unexplained = 0` on every one.

What was NOT closed is what the same check has been shouting about ever since.
`fn_ca_diamond_snapshot` also tests mirror equality, and it had raised
`DR10:mirror_mismatch` **94 times**, most recently at 03:10 today. A detector
that has fired ninety-four times for one cause is a cause nobody fixed
(CLAUDE.md 10.11).

## Measured, 1,192 profiles

|                                              |                       |
| -------------------------------------------- | --------------------- |
| `profiles.diamonds`                          | 1,022,982             |
| `diamond_wallets`                            | 1,022,482 (500 short) |
| profiles with no `diamond_wallets` row       | 5                     |
| profiles with no `user_diamond_balance` row  | 5                     |
| profiles with no `user_diamonds` row         | 4                     |
| profiles whose existing mirror row disagrees | 1                     |

The whole 500 is one account: `a57d17c9` (`codex-productio`), which holds 500
in the canonical store, has no `diamond_wallets` row, and whose `user_diamonds`
row says **100**. The other four are certification accounts at zero.

## Two causes, both closed

**1. The mirror trigger never fired at birth** (`20260907035121`).
`fn_diamond_side_tables_follow_profiles` is a correct three-way upsert, but its
trigger was `AFTER UPDATE OF diamonds` with no INSERT. A profile got its mirror
rows the first time somebody changed its balance; one born with a balance and
never touched again had none, for ever. It fires on INSERT now, including at
zero - an absent mirror row is the hole the check has to keep reporting, and a
row reading zero is the truth. Proved live: a profile inserted with 777 inside
a rolled-back subtransaction came back with 777 in all three mirrors.

**2. The signup trigger invented a balance** (`20260907035309`).
`initialize_user_diamonds` wrote `(100, 100)` into `user_diamonds` on every
signup, and `user_diamonds.balance` carried `DEFAULT 100` - the only one of the
three mirrors defaulting to anything but zero. It was never a welcome grant:
`profiles.diamonds` defaults to 0, **none** of the 429 profiles created in the
last fourteen days holds a canonical 100, and the supply meter reads
`profiles.diamonds` alone, so no player could ever have spent it. It reads the
canonical store now and the default is 0.

Nothing was taken from anybody. The one account carrying the invented 100 had
its mirror corrected **up**, to the 500 it actually holds. Five profiles
disagreed before; zero after.
