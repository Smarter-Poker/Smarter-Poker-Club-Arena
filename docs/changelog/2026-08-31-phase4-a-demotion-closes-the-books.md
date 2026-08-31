# Phase 4 of 7: a demotion closes the books

**2026-08-31.** Migration `20260901000008`, applied to production.

## What was wrong

`fn_club_set_member_role` demoted an agent by setting their `agents` row to
`suspended` and asking nothing about what that row was holding. Measured on
production before the fix:

```
active agents ...................... 111
  holding float .................... 67      (6,726,000 chips between them)
  owing credit ..................... 0
  owed commission .................. 5       (26,859.87 chips)
already stranded in suspended rows . 0
```

**Why that strands chips.** Every role except `player` may hold an agent wallet
— Dan, 2026-08-31: _"OWNERS AND CO OWNERS CAN AND SHOULD HAVE AGENT WALLETS."_
So a move to co-owner, admin, or another agent tier strands nothing; the wallet
goes with them. **Becoming a player is the one move that takes it away:**
`fn_club_bank_role` then answers `player`, and both `fn_agent_wallet_send` and
`fn_agent_wallet_claim_back` refuse that role outright. Whatever the row still
held becomes chips nobody can move, in a pool `fn_club_chip_circulation` does
not even count.

The second half was the mirror image: the row was suspended on **any** move out
of the agent tiers, **including a promotion to co-owner or admin** — which
contradicted the rule that staff hold agent wallets, and left the club bank
funding a row marked inactive.

## What changed

1. A demotion **to player** is refused while the agents row holds float or owes
   credit. The refusal returns `needs_settlement`, the two figures, and names
   only what is actually outstanding — _"holds 5,000 chips and owes 0.00"_ sends
   somebody hunting a debt that is not there.
2. The row is suspended **only** when the member becomes a player.
3. `pending_commission` is reported on every successful role change.

**No new settle path was invented, because one already exists.**
`fn_club_bank_claim_back(club, from_user, amount, 'agent_wallet', reason, op_id)`
pulls a float back into the club bank — idempotent on `op_id`, writes a
`chip_transactions` row, callable by any owner, co-owner, admin or super agent.
The refusal names it. A **debt** is not sweepable and must be settled instead;
`fn_apply_credit_payment` pays `credit_used` down when the invoice is paid
(phase 1).

## A deliberate departure from the plan

The phase 4 plan said to refuse on `pending_commission` too. It does not, and
this is the reasoning rather than an oversight: that is money the **club owes
the agent**. The agents row survives a demotion with the figure intact, so
moving the role loses nothing — and there is no payout path to send anyone to
yet (phase 6 builds one). Blocking would strand the club behind its own unpaid
obligation with no way out. It is returned instead, so the caller can say it out
loud. Overrule this if you want it to block.

## Not repaired, deliberately

- **The "11 orphaned uplines" are not orphaned.** Re-measured today: all 11
  point at a club **owner**, and that owner holds an active `agents` row. Under
  Dan's correction that owners hold agent wallets, that is legitimate data.
  Nothing to repair.
- **The 9 out-of-band rows** are a commercial question and are reported, not
  rewritten.
- **The one stranded agent** (not prepaid, no line) stays where they are, per
  Dan's instruction.

## Verification

Dry-run in a rolled-back transaction with the probes in the same transaction,
then applied. Nothing was kept.

```
1 demote to player holding 5,000    refused, needs_settlement=true
                                    "their agent wallet still holds 5,000.00 chips.
                                     Claim them back into the club bank first..."
2 agent -> co_owner holding 5,000   allowed, agents.status=active, float intact
3 agent -> sub_agent holding 5,000  allowed
4 fn_club_bank_claim_back           float 5,000 -> 0, bank 1,000,000 -> 1,005,000
5 demote to player after the sweep  allowed, pending_commission=120 reported,
                                    agents.status=suspended
6 demote while owing 750            refused: "they still owe 750.00 on their
                                     credit line. Settle the invoice first."
```

After applying: one signature, `anon` cannot execute it, `authenticated` can,
estate `agent_wallet_balance` 6,726,000 and `credit_used` 0.00 — both unchanged.

## A version collision, caught

Another agent minted `20260901000005` on `main` while this was being written.
This migration was renumbered to `20260901000008` and the migration ledger
corrected. The two files only failed to collide because their suffixes differ —
`git checkout -B` would otherwise have overwritten one with the other, which is
exactly how this programme lost a migration on 2026-08-27. **Date-shaped
migration numbers are being minted by several agents on the same day and they do
collide.**

---

# Audit pass before phase 5 (same day)

Probing the phase 4 migration rather than trusting it found **three defects in
it**, one of them a live unhandled exception. Migration `20260901000009`,
applied.

## 1. The guard missed the people phase 2 gave wallets to

`20260901000008` refused a stranding demotion only when the **old** role was one
of the three agent tiers. But phase 2 exists precisely because a co-owner and an
admin hold agent wallets. Demoting a co-owner holding float straight to player
sailed past the guard and stranded the chips, which is the one thing phase 4 was
written to prevent. Any role that is not already `player` can be holding a
wallet, and the guard now says so.

## 2. And that demotion raised, in production, on a real path

Probed against production (rolled back), demoting a co-owner to player in a club
under Midway Union answered:

```
agent commission 0.0000 is outside the union policy band (0.20 .. 0.70)
```

an unhandled `P0001`, not a refusal a client can read.

**The cause was mine.** Phase 2 taught `fn_enforce_agent_commission_bounds` to
stand aside for a rate of zero on a member the club records as **staff**. But
`fn_club_set_member_role` updates `club_members` first and `agents` second, so
by the time the trigger fires the member is already recorded as `player` and the
exemption no longer applies. The rate was zeroed while they were staff, and 0 is
outside a union band with a non-zero minimum.

**The real bug is older than either.** `trg_agents_commission_bounds` is
`BEFORE UPDATE OF commission_rate`, and Postgres fires that for any UPDATE whose
SET list _names_ the column — even when the value is identical. So an unrelated
write re-validates a rate nobody changed against a band the row may never have
satisfied. That is also why **the 9 out-of-band rows Dan has not yet ruled on
are a latent trap**: any write touching those rows could raise.

A policy band governs a rate being **set**. It now returns early when the rate
is unchanged, which fixes this demotion and every other write that happens to
name the column, without weakening the band for anyone actually setting one.

## 3. A demoted staff member kept an active agents row

The suspension was keyed on the old role too, so a co-owner demoted to player
left an **active** `agents` row behind and still read as an agent —
`fn_player_rakeback_rate` joins that row on `status = 'active'`. It is now keyed
on the role they are becoming: active while they can hold a wallet, suspended
when they cannot.

## Verification

```
1 demote co_owner holding 9,000 -> player   refused, needs_settlement=true
                                            (previously: stranded AND raised)
2 claim the 9,000 back                      success
3 demote co_owner -> player after sweep     success, wallet 0, status suspended
                                            (previously: P0001)
4 set commission 0.05, band is 0.20-0.70    still refused, band intact
5 status write naming commission_rate       accepted, as it should be
```

## Also in this pass: text on the pages

- **`index.html` carried em dashes in the `<meta>` title, description,
  `og:title` and `twitter:title`.** Those are the browser tab, the Google result
  and every shared link. Removed, and the copy Title Cased.
- **`check-ui-text` never scanned them.** It walked `src/` only, for
  `.ts/.tsx/.css`; `index.html` sits at the repo root. It now scans `.html`,
  strips `<!-- -->` comments, and reads the root `index.html` explicitly. Proved
  by reintroducing an em dash and watching the gate fail, then removing it.

Everything else in Club Arena was already clean: `check-title-case`,
`check-nav-title-case` and `check-ui-text` all pass. The remaining em dashes in
this repo are inside code comments and markdown, which no user ever sees.
