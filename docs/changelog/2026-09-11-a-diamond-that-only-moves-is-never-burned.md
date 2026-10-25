# A diamond that only moves is never burned (2026-09-11)

`ca_drift_incidents` **1610f514-d6cc-40ca-b543-6daac6cb159c**, warning, raised
by `fn_ca_diamond_snapshot` at 08:10Z, dedupe `diamond-unexplained:2026-09-11-08`:

> player diamond supply (fixtures excluded) moved by 100.00 more than the Mint
> register explains - a diamond writer is bypassing the register

## The writer

`fn_wheel_spin_core`, the paid Diamond Wheel spin. One spin, at
07:21:45.149667Z: `smarterpoker` paid 100 diamonds on `kingfish`'s club.

The function charges the price and hands it to the host's owner. That is Dan's
2026-09-10 ruling, and the function says so itself, twice:

> THE HOST IS THE HOUSE (Dan 2026-09-10). Nothing is minted: the whole price is
> taken in by the host's owner
>
> The intake is the host owner's (Dan 2026-09-10): a transfer, not an issuance.

It then journals the two legs of that one transfer differently:

| leg               | writer                                           | `issuance_class` | register                  |
| ----------------- | ------------------------------------------------ | ---------------- | ------------------------- |
| -100 smarterpoker | `deduct_diamonds(..., p_source => 'wheel_spin')` | `spend`          | **BURN 100** (`03c1bad4`) |
| +100 kingfish     | `add_diamonds_to_balance(..., 'transfer', ...)`  | `transferred`    | nothing                   |

`deduct_diamonds` decided "is this a transfer?" from a hardcoded list of
sources - `wallet_transfer`, `wallet_diamond_transfer`, `stream_gift` - and a
short list of types. `wheel_spin` was on neither, so the debit fell through to
`spend`, `fn_ca_diamond_journal_origin` returned `'spend'`, and
`fn_ca_register_diamond_journal_row` retired 100 diamonds that had not been
retired: they were sitting in kingfish's balance. The credit leg was correctly
a transfer, which the register skips, because a transfer creates and destroys
nothing.

Balances moved **0**. The register moved **-100**. That is the entire 100.

### Not a one-off

`fn_diamond_game_take_bet`, called by `fn_crash_start` and `fn_plinko_drop`,
has the same shape with `p_source => 'diamond_game'` - also not on the list.
It has not produced drift yet only because no crash or plinko bet has been
placed since it was wired to an owner; its 20 historical bets (7 crash, 13
plinko, 2026-09-09/10) predate the owner credit and were genuine burns. It
already passes `recipient_id` in its metadata, expecting exactly the branch
that was never taught to look for it.

## Proved before, and after

Both runs are one MCP call containing one `DO` block that ends in `RAISE`, so
the transaction is undone by its own error (CLAUDE.md 11.5 rule 1):

```
before  debit_class=spend        balances_moved=0  register_moved=-100.00  UNEXPLAINED=100.00
after   debit_class=transferred  balances_moved=0  register_moved=0.00     UNEXPLAINED=0.00
                                 unnamed_transfer=REFUSED P0408
```

## The fix (`20260911150027`)

1. **`deduct_diamonds` classifies by the money, not by a list.** A debit that
   names a `recipient_id` is a transfer whatever its source is called. The old
   source list stays underneath for paths that name nobody. This also fixes
   `fn_diamond_game_take_bet` with no edit to it.
2. **`fn_wheel_spin_core` names the host owner on the spin price,** so both
   legs are transfers and the register follows neither - the treatment gifts
   have had since May, the treatment the arena doors have, and the treatment
   `fn_diamond_game_pay_diamonds` already used for the diamond prize on this
   same wheel.
3. **`add_diamonds_to_balance` gained `p_counterparty_id`** so a transfer
   credit can say where it came from; it used to hardcode `player:unknown`.
   The five-argument signature is dropped, so no overload is left behind, and
   every existing five-argument caller keeps working through the default.
4. **The guard.** `ab_ca_diamond_transfer_names_its_counterparty` (BEFORE
   INSERT on `diamond_transactions`, `P0408`) refuses any row the register
   would skip **as a transfer** unless it names a counterparty player who
   exists. The skip and the guard read ONE definition,
   `fn_ca_diamond_journal_is_transfer`, so the rule that lets a row out of the
   register cannot drift from the rule that demands it name the other side.

### Why the transfer is not registered as a burn plus a mint

`ca_mint_ledger.action` is only `mint` or `burn`, and `fn_ca_mint_issued_24h`
sums **every** mint row into the rolling issuance ceiling (2,000,000 diamonds).
Recording a movement that issues nothing as a mint would inflate measured
issuance and could refuse a legitimate mint later.
`fn_ca_diamond_journal_origin` already says this in its own words about the
arena doors: the register "would have burned the float on the way in and minted
it on the way out".

## The 100 diamonds

Legitimately paid and legitimately received. smarterpoker paid 100 for a spin;
kingfish took it in as the host's owner, which is what Dan ruled should happen.
All three mirrors (`user_diamonds`, `user_diamond_balance`, `diamond_wallets`)
agree with `profiles` for both accounts, so the mirror was not bypassed either -
`trg_diamond_side_tables_follow_profiles` kept it in step.

**No player balance was changed.** What was wrong was the register, and it is
corrected FORWARD with one compensating row - `op_id`
`register-correction:wheel:84aba5a7-32e0-4aec-a1c2-d7fbdc32466b`, a mint of 100
to smarterpoker reversing a retirement that never happened - rather than by
editing `03c1bad4`, which the append-only trigger would refuse anyway. Net
register movement for that spin is now **0.00**.

## The echo, and what was deliberately not done (`20260911151842`)

A register correction moves the register and no balance, so a delta detector
sees it once. It did: the next snapshot read `-100` and raised
`647c1dc6-99b1-4a21-9d77-2d733106f4e3`. That snapshot was taken **deliberately,
minutes after the correction**, so the figure appeared while somebody was
looking at it instead of at 16:10 in front of whoever was on next. The incident
is resolved with that explanation.

The cheap alternatives were all refused, and refusing them is the point:

- the 50-diamond threshold is unchanged;
- `fn_ca_diamond_snapshot` was not edited at all, and does not skip rows with
  `origin = 'operator'`;
- nothing was reclassified as a fixture.

A detector that cannot see the house correcting its own books has a hole in it
shaped exactly like the next mistake.

## Knock-on worth knowing

`fn_ca_diamond_player_spend` counts a debit as player spend when its origin is
`spend` or `bridge`. A wheel spin price is now a transfer, so it no longer
counts there. That is the number that function's own comment asks for -
transfers "move no value out of the player economy" - and the diamonds really
are still in the player economy, in the host owner's balance. The wheel's own
P&L is unaffected: `fn_wheel_metrics` and `fn_diamond_game_pnl` read
`wheel_pools.intake_diamonds`, not the journal class.

## What I could not prove

The live gift path could not be executed (11.5 forbids spending real diamonds
to test a rule), so its compatibility with the guard is established by reading
the writers rather than by running them: `send_stream_gift` and
`send_wallet_diamond_transfer` both set `counterparty` to `'player:' || <uuid>`
explicitly on every transfer leg, and their debt-settlement legs are class
`spend` with counterparty `receivable:diamond_debts`, which the guard ignores.
Measured exposure before the change: of 50,763 journal rows in all history,
exactly **one** carried `counterparty = 'player:unknown'`, and it is the row
this incident is about.
