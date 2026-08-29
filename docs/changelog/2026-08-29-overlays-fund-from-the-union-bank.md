# 2026-08-29 — Overlays fund from the union bank, and 570 tournaments an hour stop being refused by the wrong wallet

Dan, binding: _"ALL TOURNAMENTS THAT ARE SHORT OR HAVE OVERLAYS ARE FUNDED FROM
THE UNION BANK WALLET (OR FROM THE CLUB WALLET IF IT'S A STAND ALONE CLUB WITH
NO UNION AFFILIATION). THERE SHOULD NEVER BE ANYTHING PREVENTING NEW
TOURNAMENTS TO RUN, AS LONG AS THE BANK HOLDS ENOUGH CHIPS TO COVER. IF THEY
DON'T, A POP UP MUST APPEAR LETTING THE CLUB OR UNION KNOW THEY NEED MORE
CHIPS IN THE BANK TO COVER THE GUARANTEE."_

## What was actually live, verified against the database

Migration `20260827f` claims this rule was already applied via MCP. **It was
not.** Read directly from production today:

- `fn_apply_prize_guarantee` debited `clubs.chip_treasury` **unconditionally**.
  The `bank_type` / `bank_entity_id` / `union_id` columns that 20260827f added
  to `tournament_guarantee_overlays` exist and were never written. Half the
  change shipped; the half that moves money did not.
- `trg_tournaments_guarantee_affordable` (the BEFORE INSERT guard on
  `tournaments`) read `clubs.chip_treasury` only.

The consequence, measured this morning: Midway Union's club treasury sat at
**-7,161.10** — structurally negative for a union club, because union clubs
never receive rake into `chip_treasury`; it returns at the weekly rakeback
close — so the guard refused **~570 scheduled tournament creations per hour**,
while **the union bank held 136,473.58 chips**, more than four times the
31,350 promised across every live event. Tournaments were being blocked by a
wallet that was never supposed to be paying for them. And nobody was told: the
refusal was an error string in a server log.

## The rule, implemented

One question decides everything: **which bank pays this club's overlays?**

```
clubs.union_id IS NOT NULL  ->  union_wallets.chip_balance   (the union bank)
clubs.union_id IS NULL      ->  clubs.chip_treasury          (standalone club)
```

**The funder debits that bank. The guard reads that bank.** Same bank, same
arithmetic — or the guard blocks events the funder could pay (today's bug), or
waves through events the funder cannot (the opposite bug).

For a union bank, exposure is summed across **every club sharing it** — three
clubs promising against one wallet must be counted together, or the wallet can
be promised three times over.

The guard still refuses when the bank genuinely cannot cover — that is Dan's
own rule ("as long as the bank holds enough chips") — but the refusal message
now names the bank that is short and says what to do:
`...union bank holds X ... short by Y. Add chips to the bank to cover the guarantee.`

Every union-bank debit writes a `union_wallet_transactions` row
(`tx_type='guarantee_overlay'`), and the overlay ledger's `bank_type` /
`bank_entity_id` / `union_id` columns are finally written. A union missing its
wallet row falls back to the club treasury rather than stranding the claimed
overlay, and records that it did.

## The pop-up

A BEFORE INSERT trigger that raises **rolls back everything it wrote itself**,
including any notification. So the refusal cannot notify from inside the
guard. The other half is `fn_notify_guarantee_bank_short(club_id)`:

- called by `ScheduledTournamentService` (both the spawn path and the restart
  path) from a fresh transaction when an insert fails with the guard's
  signature;
- writes the durable bell notification — **"More Chips Needed To Cover
  Guarantees"** (First Letter Of Every Word Capitalized, no em dashes, per
  CLAUDE.md rule 7) — to the **club owner**, and to the **union owner** too
  when the short bank is the union's, since the union owner is the one who can
  fund it;
- **dedupes on unread** per recipient per bank, so a schedule re-failing every
  30-second poll produces one standing notification, not a storm. Read it and
  the next refusal may raise it again;
- the UI creation path needs nothing: the modal already toasts the trigger's
  message verbatim, which now tells the owner which bank is short.

Also fixed while here: the engine's funding log asserted "debited from the
club treasury" unconditionally. It now reads `bank_type` from the RPC —
naming the wrong wallet in a money log is how the next reconciliation chases a
debit that never happened.

## Verification

The SQL was probed against production **inside rolled-back transactions** per
CLAUDE.md 11.5: a 300-chip guarantee for Midway Union — refused this morning —
is **accepted**; a 500,000-chip guarantee is **refused with the union bank
named** in the message. Nothing committed, no chips moved.

The immediate effect needs no deploy: the guard and funder are database
functions, so scheduled tournaments resume spawning on the next 30-second
poll. The notification half rides the next engine deploy.

`npx tsc --noEmit` exit 0. 5 new pins in `GuaranteeBankNotify.test.ts`,
including one that the migration contains the actual function bodies — because
20260827f taught what a doc-only migration costs: three weeks of the platform
running on the wrong wallet while the repo said otherwise. The
`TournamentIntegrity.2026-08-27.guard.test.ts` invariants (exactly three
`applyPrizeGuarantee` call sites, no local pool fallback) still pass.
