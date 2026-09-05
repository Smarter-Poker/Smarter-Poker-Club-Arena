# Club Operations Phase 7: an approval can be retried, and a freeze means something

Phase 7 of 8 of Dan's Club Operations upgrade
(`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`, section 9). The surfaces
are the two cashiers, the chip-request queue and the settlement page.

The write paths themselves are the best-defended code in this workspace and
this work does not touch them: `fn_agent_wallet_send` still takes its mandatory
retry key, takes its advisory lock, replays on the op id and refuses a key that
belongs to a different intent; `fn_cashier_batch_transfer` still validates the
whole envelope before the first item moves. What was wrong is what wrapped
around them.

Everything below was proved against production inside a transaction that was
rolled back (CLAUDE.md 11.5) before anything was changed.

## Approving a chip request could not be retried

`fn_respond_chip_request` locks the request `FOR UPDATE` and refuses anything
not `pending`, so a double tap could never send twice - that part was sound.
But for the money move it called

```sql
fn_agent_wallet_send(..., gen_random_uuid())
```

a **fresh retry key on every attempt**. So in the one case a retry key exists
for - a response lost on the wire - the chips had moved, the request was
approved, and the operator's retry was told **"request already approved"**,
which the client turns into a red toast. Money moved; the person who moved it
was told it had not. That is the worst shape a money screen can take.

`chip_requests` has carried an `op_id` column, with a unique index on
`(club_id, requester_id, op_id)`, since requests themselves were made
idempotent. The retry key was designed into this table and the approval path
simply never used one.

Now the send's key is derived from the request id, so it is the same key on
every attempt and `fn_agent_wallet_send` replays instead of re-sending. A retry
that arrives after the request is already approved no longer reports a failure:
it looks for the `chip_transaction` written under that key and returns the
original receipt with `replayed: true`.

**It only claims a replay when it can see the transaction.** Approvals made
before this migration used a random key, so nothing is found under the derived
one and those keep the old honest refusal - re-sending them is the one outcome
that would actually move money twice.

Proved, then rolled back:

```
D. approve #1        {"status":"approved","success":true,"replayed":false,
                      "your_balance":130987.66,"their_balance":9728.54}
E. approve #2        {"status":"approved","success":true,"replayed":true,
   (the retry)        "transaction_id":"37fc6356-...","amount":12.34}
F. sends under the derived key: 1
```

## A declared settlement freeze froze nothing

`clubs.settlement_locked` is what an operator sets to stop chips moving while
the books are squared. Measured: the only two functions in the database that
read it are `expire_settlement_locks` (the sweep that clears it) and
`ca_club_operations_overview` (which displays it). **No money function read it
at all** - not the sends, not the claim-backs, not the batch transfer.
`checkSettlementLock` exists in the client, fails open by design, and is called
from the classic cashier only; the Trade cashier never checked it.

It is enforced now the way the platform already enforces its maintenance freeze
(CLAUDE.md 13): a `BEFORE INSERT` trigger on `chip_transactions`, not a check
bolted into each of the four money functions - so a path nobody remembered
cannot slip past it, and the 191-line defended bodies stay untouched.

**What it freezes, and what it deliberately does not.** A settlement freeze is
about operator movement - sends, claim-backs, commission claims, promo pushes,
admin removals. It must never stop a game, and `fn_atomic_buyin` writes a
`mint` row, so freezing mints would refuse buy-ins mid-session. Every gameplay
type is excluded by name, `service_role` keeps its escape so the settlement
runner can still move the chips the freeze exists to protect, and the test pins
both halves.

Proved, then rolled back: with a freeze declared, approving answers _"this club
is squaring its books - approvals resume when the settlement freeze lifts"_;
with it lifted, the same approval succeeds. Nothing is locked today (0 of 4
clubs), so this changes no behaviour on the platform as it stands - it makes
the switch real for the first time.

The trigger's own refusal cannot be exercised from psql: `session_user` there
is `postgres`, which the guard treats as an internal caller by design. Its
shape is asserted by the migration and its user-visible effect is the refusal
above - the same limitation recorded in phase 5.

## The settlement page wrote to whatever the URL said

`.eq('id', clubId)` with the **route param** - a club code on every
`/clubs/<slug>/settlement` URL - against a uuid column, on both the read and
the write. Two consequences, both live:

- the read answered 22P02 and the `catch` swallowed it as "non-critical", so a
  club with auto-settlement **ON rendered OFF**;
- the write had no `.select()`, so when RLS refused it - `clubs` is UPDATE-able
  only by `owner_id = auth.uid()`, which a co-owner or admin is not - PostgREST
  returned 204 with no error and the page toasted "Auto-settlement enabled" for
  a switch that had not moved.

The resolved uuid was already in hand a few lines above. It is used for both
now, the write asks for the row it changed and says who may change it, and a
switch drawn from a failed read reads **"Auto: Unknown"** rather than a
confident OFF.

## The two cashiers disagreed about what a chip is

The classic cashier refused any fraction - "Chips must be a whole number" -
and its comment and its test both explained why: "the per-club ledger column
(`club_members.chip_balance`) is an integer, so a fractional amount is rounded
on write". **That premise is false**, and measuring it was a one-line query:
the column is `numeric(20,2)`. It stores 12.34 exactly and nothing rounds.
Meanwhile the Trade cashier on the same platform accepts two decimals and says
so, so the same operator could send 0.50 from one screen and be refused it on
the other.

The classic page now accepts two decimal places and refuses a third, which is
what the column can hold. The exponent rule ("1e9" - a billion chips from four
keystrokes) and the ceiling stay exactly as they were, because both were real.

## The settlement period was not this club's, and the header proved it

`get_current_settlement_period()` takes no club argument:

```sql
FROM settlement_periods sp WHERE sp.status = 'open'
ORDER BY sp.start_at DESC LIMIT 1
```

the newest open period **on the platform**, whoever is looking. Measured, that
single open row is `5a9811f0`: **club_id NULL**, union-scoped, running
2026-08-16 to 2026-08-23 - three weeks stale and belonging to no club. Every
club's settlement page has been headed by it.

The client then threw away what the row does carry. `period_number`, `year`,
`total_bbj_contributions`, `total_player_winnings`, `total_player_losses` and
`total_hands_dealt` are all real columns, and `SettlementService` replaced them
with `periodNumber: 1`, this year and four zeroes - which is the whole of
"Period 1/2026 over a grid of zeros". One period in that table carries 4,719.32
of rake, 259.07 of drop and 267,312 hands.

`get_current_settlement_period(p_club_id)` is a new overload - the no-argument
one is unchanged and still serves the union surfaces - and answers for one
club: its own open period, else its own work still in flight (processing or
disputed), else its union's open period **marked as the union's**, else its
most recent of any status. It creates nothing: a club that has never been
settled gets no rows, and the page now says so instead of heading itself with
someone else's week. Proved before applying: SHARK and JAQK each get their own
period 33/2026, and the reference club correctly gets nothing.

Two more from the same page, both about telling the truth:

- **`disputed` was missing from the page's own type.** It listed three of the
  four statuses the column holds and cast the server's value into it in three
  places, so a disputed period drew a badge with no text at all. There is one
  in the table, disputed since March.
- **The receipt hardcoded `status="paid"`** for any period marked settled,
  without reading a single invoice's payment state. It reads `settled_at` now,
  and so does the timeline beside it.

One item in the plan is already fixed and I am not touching it: "Execute
Settlement calls a documented no-op" - the button now says plainly that agent
commissions settle through credit invoices and player rakeback through the
engine settler.

## The cashier stopped contradicting itself

Three hundred lines above its confirmation dialog, the classic cashier shows a
preview row reading **"Claim Back Window: Ten Minutes"**. The dialog said
**"This Action Cannot Be Undone."** That is not a scarier warning, it is a
false one: an operator who believed it would never go looking for the Claim
Back that could still save them. It now says what is true - the send can be
claimed back for ten minutes and not after that - and still asks them to check
the amount and the recipient.

The same page reported every outcome through 35 hand-rolled `setMessage` calls
in sentence case, bypassing the central popup rule (CLAUDE.md 5.7). Rather than
rewrite 35 call sites on a working money screen, the three places that RENDER
that banner now pass the text through `formatPopupText` - the one function the
law names - so every one of those messages is Title Cased and em-dash free
without touching a single caller.

## The agent breakdown stopped re-deriving what the engine already wrote

This is the item phase 6's gate handed over, and it is why
`/clubs/<slug>/data` showed dashes where the rake panel should be:

```
ca_club_data_snapshot   200 in   300-1,000ms
ca_rake_snapshot        500 in  ~8,200ms   (57014 statement timeout)
```

Inside `ca_rake_snapshot`, `fn_ca_rake_window` is 0.6s and
`fn_ca_rake_series` 0.13s. **`fn_ca_rake_by_agent` is 29.7 seconds.** Its
`from_live` CTE covers the days not yet in `club_rake_rollup_complete` - which
always includes today - by calling `fn_rake_shares_for_record` **once per raked
hand**: 61,156 index lookups plus a `NOT EXISTS` each, every time an operator
opened the page. Expanding the same rows set-based from `player_contributions`
instead still cost 11.5 seconds, so this was never a query to tune.

It did not need a new rollup, because the rollup already existed one layer
down. `rake_attributions` **is** the per-player credit, written by the engine
as the hand is raked, and `club_rake_daily_user` - the completed-day rollup
this function already trusts - is built from it. So the live edge now reads
that same table, grouped.

Measured through PostgREST as the club owner, with the function changed and
**no index yet**:

```
before   ca_rake_snapshot   500 in ~8,200ms   (57014 statement timeout)
after    ca_rake_snapshot   200 in  2,128ms / 2,577ms  (month, the page default)
         ca_rake_snapshot   200 in  2,554ms / 2,362ms  (year)
```

and the panel renders: 5 daily series points, 34 agent rows, 351,310.13 of
direct rake and 183,266.92 of commission where it showed dashes.

**The index ships separately, in `20260905042500`, and it is the only part
that waits for the `:55` freeze.** `rake_attributions` takes a row per player
per raked hand, so a plain `CREATE INDEX` on 1,131,048 rows / 456 MB blocks
the engine's writers for the length of its scan, and `CREATE INDEX
CONCURRENTLY` cannot run inside the single transaction a migration must be.
The function change needs no lock at all, so holding it back until the freeze
would have left the panel failing for no reason. With the index the remaining
serial scan in `from_live` - 573,468 heap rows to keep 14,091, measured at
2.8s of the total - becomes an index-only read of the same range.

### And it shipped behind the wrong grant for twelve minutes

`20260905042100` carried

```sql
GRANT EXECUTE ON FUNCTION public.fn_ca_rake_by_agent(...)
  TO authenticated, service_role;
```

which is the shape every GATED RPC in this programme uses, applied to the one
family where it is wrong. **`fn_ca_rake_by_agent` is not gated.** It computes
`v_cost` and `v_over` to decide which COLUMNS a caller may see and then reads
the club's whole agent breakdown regardless of who asked; its gate lives one
level up in `ca_rake_snapshot`, which is why all four of its siblings are
granted to `service_role` alone. For the twelve minutes between the two
applies, any signed-in user could have called it with any club id and read that
club's per-agent rake, hands and commission totals.

`tests/the-rake-snapshot-denominator-is-not-double-counted.law.test.ts` caught
it in the full-suite run before the commit - not in review, not in a browser.
The grant was closed against production immediately (a grant change fires no
PostgREST schema reload, CLAUDE.md section 2), and `20260905043000` re-issues
the function with the correct grant so the repo matches. Verified after:

```
fn_ca_rake_by_agent  called directly as a signed-in user   403  42501
ca_rake_snapshot     the gated door, same user             200  1.5-3.6s
```

The law itself moved one step, and the direction matters. It used to say _no
migration may ever contain that grant_, which an applied migration can never
satisfy again - the bad line stays in the tree forever, because an applied
migration is never edited. It now says _a helper opened to `authenticated` must
be closed again by a LATER migration_. An uncorrected mistake still fails it,
which is the case it exists for; a corrected-forward one does not.

### The law that pinned the old mechanism moved with it, and one of its pins had stopped guarding anything

`tests/the-agent-table-is-current-not-merely-complete.law.test.ts` exists
because `fn_ca_rake_by_agent` first shipped reading `club_rake_daily_user` and
nothing else, so on the Day period the agent table showed 0.00 under a
five-figure headline. Its invariant - **a rollup-only read is always wrong for
today, and always looks right** - is untouched by this work and is exactly what
the new `from_live` upholds. Two of its pins named the OLD mechanism and moved,
in this commit, as CLAUDE.md 5.8 requires:

- `rake_records` becomes `FROM public.rake_attributions ra` plus
  `GROUP BY ra.player_id`.
- `fn_rake_shares_for_record` - "the canonical allocator, so a live figure and
  the rollup that eventually replaces it agree" - becomes a pin on the rounding
  the rollup itself uses. The guarantee is now structural rather than
  procedural: both sides read the same rows, so they cannot drift apart, where
  before two code paths had to be kept in step.

That second pin **had already stopped guarding anything**, which is worth
saying out loud rather than quietly fixing. It asserted the body CONTAINS
`fn_rake_shares_for_record`, and the new migration's own assertion names that
function in order to check the body no longer calls it - so the pin passed on
the guard instead of on the code. It now asserts the absence of
`fn_rake_shares_for_record(`, with the paren, because only a call has one. A
third pin was added for the rounding. The law came out of this with nine tests
where it had eight; nothing in it was relaxed.

### Why the first apply failed

This is worth writing down twice: the
migration asserted that the new body no longer names `fn_rake_shares_for_record`,
and the new body NAMES it in the comment explaining what it replaced. The
assertion strips `--` lines from `prosrc` before looking now. It is the third
time in this programme that a definer assertion has fired on its own prose.

**One consequence stated plainly.** The old path could also reconstruct a share
for a raked hand that has no attribution rows at all - 191 hands of 93,465 on
2026-09-03, 0.2%. Those hands are already absent from every completed day,
because the rollup they feed is built from attributions too. So today stops
being counted on a different basis from yesterday, which is the point of this
programme, and the small set that is missing is now missing consistently rather
than only after midnight. If those hands matter, the fix is to write the
attributions, not to reconstruct them differently in one report.

## The bomb pot report was never role-dependent, and it had been forgetting its own history

The phase 6 gate handed this over as a mystery, honestly labelled: the report
was **684ms called as `postgres` and 9.7 and 17.3 seconds called as
`authenticated`**, with the index, RLS, a second overload and the `safeupdate`
preload all ruled out by measurement, and no explanation for what was left.

**The 684ms baseline was the function refusing.** Its first statement is

```sql
v_uid uuid := auth.uid();
IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' ...
```

and a psql session as `postgres` carries no `request.jwt.claims`, so
`auth.uid()` is NULL and the call raised 28000 in 88ms without reading a single
hand. Every "fast as postgres" figure in that report was the timing of an
error. Holding the ROLE constant and changing only the claims:

```
postgres, no claims                 ERROR not_authenticated       88ms
postgres, the owner's claims          50 rows              31,715ms
postgres, same claims, called again   50 rows                   384ms
```

Same role, same session, same data: 31.7 seconds, then 384ms. Across sessions
the same call has measured 0.4s, 1.8s, 3.5s, 5.1s and 31.7s depending only on
what happened to be resident. It is a **cold cache**, and this is precisely the
read that is never warm: ~20,200 bomb pot hands, each a wide `hand_history` row
whose `players` jsonb is TOASTed and is read only to count seats, for a report
an operator opens perhaps once a day. Through PostgREST the 8s statement
timeout killed the cold call - so the read that would have warmed the cache
could never finish. It could not bootstrap itself out of the cold state, which
is why it looked permanent.

### And a second defect, found while measuring the first

The report reads `hand_history`, and `sp_prune_hand_history` deletes horse-only
hands after seven days - Dan's ruling, the one sanctioned asymmetry in CLAUDE.md
10.5, and a storage decision rather than a player one. So **asking this report
for 365 days returned seven**, and said so with a number rather than a gap: a
quarter that contained bomb pots read as a quarter that did not. Today the table
holds bomb pot hands for 2026-08-29, 08-30, 09-01, 09-02, 09-03, 09-04 and
09-05, and nothing else.

### One rollup fixes both

`ca_club_bomb_pot_daily` holds one row per club, day, table and bomb pot shape -
which is exactly how the report already grouped - with sums rather than
averages, so a range averages over the range instead of over the daily averages.
`ca_club_bomb_pot_complete` marks which days are sealed, including days that
held no bomb pots at all, because a day with none is a fact and without the
marker it would be re-scanned live for ever. The rollup is a few hundred rows
where the hands are twenty thousand wide ones, so it stays resident, and it
outlives the pruning, so the history stops disappearing.

**Nothing new is attached to `hand_history`** - 221,000 inserts a day on the
engine's hottest path - and there is no new scheduler: World Hub CLAUDE.md 10.9
and 11.3 send scheduled application logic to Open Claw, which a Club Arena agent
may not deploy to. The rollup catches itself up lazily from inside the report,
the way `fn_club_table_daily_catchup` already does. The first read after
midnight seals one day (~700 hands); every read after that is the rollup plus
today.

**A day is sealed fifteen minutes after it ends, never at midnight.**
`bomb_pot_award_units` is written as the pot is awarded and a sealed day is
never recomputed, so a unit landing late from 23:59:59 would otherwise write a
wrong scoop/split count permanently.

Proved before applying, inside a transaction that was rolled back: the report's
fifty rows captured before and after the rewrite, `EXCEPT` in both directions,
zero rows either way. The migration then re-checks the rollup against the hands
for the newest sealed day and aborts if they disagree (they agreed:
425,485.80 chips for 2026-09-04).

Measured through PostgREST as the club owner, after:

```
before   fn_club_bomb_pot_report   500 after ~8,200ms   (57014)
after    p_days=30    200 in 1,916ms then 1,165ms
         p_days=90    200 in 1,320ms
         p_days=365   200 in 1,268ms
```

The range no longer changes the cost, which is the point: a year costs what a
month costs, because only the unsealed days are read from the hands.

## Two things measured and deliberately left

- **`fn_club_cashier_members_page_v3` really does re-run the recursive downline
  walk on every page** (v3 selects from v2, which selects from v1). It costs
  241ms cold and 121ms warm for page one of 417 members on the busiest club.
  Rewriting a working money-adjacent read to save 100ms is not worth the risk;
  the note in the plan says what to do if a club ever grows into it.
- **"Execute Settlement calls a documented no-op" is already fixed.** The
  button says plainly that agent commissions settle through credit invoices and
  player rakeback through the engine settler, and keeps its success branch as a
  tripwire. The plan entry was stale; it is marked so.

## Verified

- Migrations `20260905040100`, `20260905041500`, `20260905042100`,
  `20260905043000` and `20260905051000`, one transaction each, applied and
  recorded. `20260905042500` - the index alone -
  is queued for the `:55` freeze, because it is the only statement here that
  takes a lock on a table the engine writes on every raked hand.
- `ca_rake_snapshot` read live through PostgREST as the club owner after the
  change: 200 in 2.1-2.6s where it was 500 after 8.2s.
- Every behaviour above proved live inside a rolled-back transaction.
- 27 pins in `tests/unit/anApprovalCanBeRetried.test.ts`; the amount pins
  in `CashierAmountValidation.test.ts` moved to the new rule with the measured
  reason, in the same commit.
- The discarded-error ratchet caught the improvement it should:
  `SettlementPage.tsx` went from 2 discarded reads to 0 and moved to
  AUDITED_ZERO.
- Full suite green (13,105 tests), all local gates OK.

## Still open in this phase

`fn_club_cashier_members_page_v3` re-running the recursive downline walk on
every page (measured, deliberately left, above). The bomb pot report carried
from phase 6 is closed - it was never role-dependent, and both of its defects
are fixed above.

Two smaller things measured here and not changed:

- **`agent_commissions` has no `(club_id, created_at)` index either.** The
  `commission` CTE bitmap-scans 694,941 rows for a seven-day window and costs
  1.14s of what remains. It is a second index on a second hot table and belongs
  in a freeze of its own, once the first one has been observed landing.
- **`ca_rake_snapshot` emits `rake_complete_through` as a hardcoded NULL** in
  both of its branches, and that turns out to be correct rather than a stub:
  the breakdown reads live now, so there is no complete-through day to name,
  and the client type says exactly that. Nothing renders it - the panel uses
  `breakdown_live`, and the identically named field the Club Data foot note
  DOES render comes from `ca_club_player_breakdown`, which computes it. Checked
  because a hardcoded NULL usually is a stub; this one is a retired field kept
  for older payloads.
