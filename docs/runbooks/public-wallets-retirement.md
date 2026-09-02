# Decision package: retiring `public.wallets` (to-do #2563 item 13)

The reconciliation itself is a financial decision and is Dan's to make. This
document is everything needed to make it, measured live on 2026-09-01, so the
decision does not require another investigation.

## The measurements

| Fact                                              | Value                                                         |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Chips stranded in `public.wallets`                | **732,591,994.33**                                            |
| Rows                                              | 2,336                                                         |
| Stranded total change since the 2026-08-21 freeze | **0.00** - identical to the figure recorded in CLAUDE.md 11.5 |
| Rows touched in the last 7 days                   | 484 (~480/day)                                                |
| Balance sum of recently-touched rows              | **0.00**                                                      |

Reading: **no money is actively leaking into or out of the pool.** The daily
writes are zero-balance row touches (consistent with horse onboarding
creating wallet rows), not chip movement.

## The two armed leak paths

Two browser-callable RPCs still `UPDATE wallets` when invoked (confirmed from
`pg_get_functiondef` on the live database):

- `atomic_chip_transfer` - called by `src/services/ChipFlowService.ts:96`
- `wallet_user_transfer` - called by `src/services/WalletService.ts:446`

Any real use of those client paths today sends chips into a pool nothing
reads - the money vanishes from the caller's view. The unchanged stranded
total says these paths have not fired with real amounts since the freeze, but
they are loaded weapons. They were deliberately NOT revoked in the Phase 2
vault-door migration because they have live client callers; the correct fix
is to repoint the FEATURES that call them at the live pool
(`club_members.chip_balance` via the sanctioned transfer RPCs), then revoke,
and that needs whoever owns those two client features to confirm intent -
blind-rewriting a money function from a guess is the 10.5 incident shape.

## The options for the 732.59M

1. **Return to club treasuries** pro rata by each wallet row's club
   affiliation (where derivable). Most faithful to "chips belong to clubs";
   needs a mapping pass because `wallets` rows are per-user, not per-club.
2. **Return to `club_members.chip_balance`** for each row's user where a
   membership exists - most faithful to "these were players' chips".
   Complication: a user in several clubs has no unambiguous destination.
3. **Write the pool off to a single house ledger row** with a journal entry -
   simplest, fully auditable, but declares the chips house property.
4. **Leave it frozen** (status quo) - costs nothing, but every future audit
   pays the "why is there a 732M pool nothing reads" tax again, and the two
   armed paths remain armed.

Whichever option: one migration, journaled through `chip_ledger` with a
dedicated category so `reconcile_ledger_nightly` sees the movement, applied
inside a maintenance freeze window for a platform standing still.

## What was already done (no decision needed)

- Phase 2 closed every OTHER wallets-writing legacy RPC to browsers
  (`add_to_player_wallet`, `deduct_player_wallet`, `mass_fund_horses`, ...).
- The freeze guard's `zz_freeze_guard` trigger sits on `wallets`, so during
  breaks even the armed paths are refused.
