# Phase 3 Bounty And Satellite Evidence

This is a scoped evidence checkpoint for B01-B11 and AX11 in the Club Arena
12-phase audit. It does not close Phase 3 or authorize Phase 4.

Source commit: 40886c94ab69fd37a47957b3ea3b23b5a0c0e375. Production catalog observed on
2026-09-10 at 03:30:58 UTC. This change adds tests and evidence only; it changes
no production behavior and makes no production financial writes.

## New Executed Evidence

`server/src/tournament/MysteryActivationCutoff.test.ts` executes the actual
`TournamentManagerBase.maybeActivateMysteryBounty` method, actual
`countPaidPlaces`, and production predicate, pool, inventory and shuffle helpers.
Only database transport and infrastructure are controlled.

All six cases passed:

1. An open entry pool cannot seed even when every table is parked for a break.
2. Stale finalized memory does not announce activation when the database refuses.
3. A closed pool remains pending while a table has a hand in progress.
4. The accepted 27-player activation submits 26 uniquely numbered chests totaling
   50,000 cents, then adopts and broadcasts once.
5. A transport error leaves activation retryable without announcing success.
6. An already stored active stage is adopted without another seed or announcement.

This fills an engine wiring gap in B04. It is not a PostgreSQL funding rehearsal:
the seed RPC response is controlled. It does not prove deadline extension,
simultaneous entry closure, complete trigger composition, hand-boundary exclusion
during a database round trip, or production gameplay.

The existing pure predicate and add-on finalization tests were reviewed, not
rerun. The satellite cash correction's eight PostgreSQL groups were not repeated.

## Live Catalog

The seed, add-on close, activation receipt and pending-head guard retain the
previously reviewed installed bodies. The seed locks the event and refuses an
unfinalized entry pool. The add-on close refuses a deadline still in the future
before delegating to the atomic finalizer.

| Function                                                          | Body MD5                         | Execute Access            |
| ----------------------------------------------------------------- | -------------------------------- | ------------------------- |
| fn_mystery_bounty_seed(uuid,integer,jsonb)                        | f78272f535468f7399c78d5c4ec87e35 | Service                   |
| fn_close_tournament_addon_period(uuid,text)                       | b503380118722ce9a5b8b4467f3c48fd | Service                   |
| fn_receipt_mystery_activation()                                   | 96c4626eda4c43c3b355a752199f89bd | Trigger body inspected    |
| fn_refuse_mystery_activation_with_pending_heads()                 | 0e2dc405aada5f99bfffe5738748d301 | Trigger body inspected    |
| fn_collect_bounty(uuid,uuid,uuid,jsonb)                           | 0f331ccc9079142ea254643b112a54ca | Service                   |
| fn_mystery_bounty_reserve(uuid,uuid,jsonb,uuid,text,uuid,integer) | 789f33328d2641870eeaf23bba2f582a | Service                   |
| fn_mystery_bounty_pay(uuid)                                       | 24dcb1cc3a72e7e9e5cdd94432a64064 | Service                   |
| fn_mystery_bounty_reveal(uuid,uuid,boolean)                       | 5578ec53c8a531eeba47d448ae9af1b1 | Authenticated and service |
| fn_mystery_bounty_settle(uuid,uuid)                               | 5c86ea2c44c5138577706ea30d3e1f27 | Service                   |
| fn_award_satellite_seat(uuid,uuid,uuid,text,integer)              | b0a05e8e90bced99d121375c9a7b9c88 | Service                   |

The owner-only legacy helper `fn_mystery_bounty_pay_unguarded_20260907(uuid)`
has no anonymous, authenticated or service execution grant. Catalog identity
and permissions identify the reviewed functions; they do not prove payment
conservation.

## Control Disposition

| Control | Verified Portion                                                                                                                                                                             | Remaining Acceptance                                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B01     | Entry/refund split evidence exists in the prior Phase 3 corrections; bounty function catalog recorded above.                                                                                 | Funded entry, carried heads and actual paid rewards must reconcile through real bounty settlement.                                                                  |
| B02     | Production attribution selects the final eligible pot; its durable evidence gate refuses modern missing-pot and fallback attribution. Existing side-pot and tied claimant tests are present. | Execute accepted-hand evidence through the installed payer for side pots, tied winners and supported split-pot variants. Source inspection alone does not close it. |
| B03     | Installed collection and settlement authorities identified.                                                                                                                                  | Execute PKO cash plus carried portion conservation and final winner own-bounty treatment against installed money functions.                                         |
| B04     | Six real engine-method cases above; unchanged installed closed-pool and add-on deadline guards.                                                                                              | Complete cutoff/finalizer PostgreSQL composition and the relevant cross-boundary races before closing the whole control.                                            |
| B05     | Activation submits the complete N-minus-one inventory with exact total and distinct sequence identities in the new engine test.                                                              | Installed funding, reservation concurrency and one entitlement per draw remain to be exercised together.                                                            |
| B06     | Engine does not reseed or reannounce a stored activation in the new case.                                                                                                                    | Award reveal/payment replay, public inventory and winner display require a connected end-to-end proof.                                                              |
| B07     | Installed seat-award authority and atomic settlement receipt paths identified.                                                                                                               | Actual source-to-target escrow transfer, original event identities and concurrent replay remain open.                                                               |
| B08     | Reuse the live cash-refund correction 20260909222303 and its prior eight PostgreSQL groups.                                                                                                  | Duplicate qualification and cancelled-target policies require their separate actual money-path acceptance. No tickets or historical repairs added.                  |
| B09     | Installed award and outcome-resolution authorities identified.                                                                                                                               | Race target closure and concurrent target admission with funded award or the approved cash alternative.                                                             |
| B10     | Existing field-sized guarantee and conservation migrations are present.                                                                                                                      | Execute below-advertised-seat-count funding and leftover awards using independently funded escrow.                                                                  |
| B11     | A Shootout constant alone does not prove that a format is offered.                                                                                                                           | Map actual offered deal/format controls and their runtime enforcement before declaring this control inapplicable or complete.                                       |
| AX11    | Reuse registration split evidence; coordinate with the payout lane for terminal and guarantee fixtures.                                                                                      | Execute paid places, bubble refund, fee, bounty and guarantee together against independent funding before ladder publication.                                       |

No full B control is newly marked verified by this checkpoint. The scope is kept
separate from the shared phase register so parallel audit lanes do not overwrite
each other's conclusions.
