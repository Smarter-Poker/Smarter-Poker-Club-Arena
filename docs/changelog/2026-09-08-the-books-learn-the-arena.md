# Phase 5.3: the books learn that a diamond can sit on a felt

2026-09-08. `supabase/migrations/20260908114517_the_books_learn_the_arena.sql`.

The arena club now exists, so its doors are live. Not one diamond reporting
surface knew an arena wallet could exist. Three defects followed, all latent
until the first deposit, none of which had surfaced only because the arena held
zero.

## 1. A deposit would have burned the money it parked

`fn_arena_deposit` writes a negative journal row with class `arena`. Asked what
that row was, `fn_ca_diamond_journal_origin` answered **`spend`** - so the
register would have recorded a BURN of every diamond deposited, while the
diamonds themselves sat safely in a club wallet. Supply would have understated
the platform's own liability by the entire arena float, permanently and
silently.

The mirror image was worse. A withdrawal classified as `arena`, which the
register reads as a **mint** - so taking your own diamonds back out would have
created them again.

A deposit is neither. It is money moving between two accounts of the same owner,
which is exactly what the classifier already says about a player-to-player
transfer and for exactly the same reason: supply moves, none is created or
retired. Both arena kinds return NULL there now, beside the transfers, and the
positive `arena` branch narrows to the `arcade%` awards it was really written
for. A deposit also stops counting as "what players spent playing" - parking
money is not spending it.

## 2. The identity would have broken on the first deposit

`fn_ca_diamond_trial_balance` asserts `players + house = register`. Diamonds in
an arena wallet are in none of those three, so the register row would have
reported a break for money that had gone exactly where it was meant to go. The
trial balance gains an `arena_wallets` row and the identity is now
`players + house + arena = register`, which is what it always meant.

## 3. The chip supply snapshot would have counted diamonds as chips

`fn_ca_supply_snapshot` sums `club_members.chip_balance` and four `clubs`
columns across every club. Arena member wallets are denominated in diamonds and
live in the same columns, so every diamond on the felt would have been added to
the chip supply. All six aggregates exclude the platform club now.

The chip TRIAL BALANCE is untouched, deliberately: it works from `chip_ledger`,
and the `club_members` auto-ledger fires only on `promo_balance`, so an arena
deposit writes it no rows at all.

## The deploy gate

`ca_diamond_snapshots` gains `arena_diamonds`, and the gate's basis is
profiles + arena on **both** sides of the comparison, so a deposit nets to zero
and never reads as unexplained. A gate that fires on correct behaviour is a gate
somebody switches off.

## Verified by a real round trip

Inside a rolled-back transaction, acting as a real player: deposited 200
(arena float 200), withdrew it back. `fn_ca_mint_supply('diamonds')` was
unchanged at 3,330,268 throughout, and `players + arena - register` read exactly
0 before, between and after.
