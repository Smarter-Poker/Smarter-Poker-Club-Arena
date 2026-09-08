# One source of truth for rake (union accounting programme, Phase 6 of 8)

2026-09-07, 21:20 - 22:15 UTC. Branch `fix/one-source-of-truth-for-rake`.
Three migrations applied and byte-matched to production
(`20260907214446`, `20260907215753`, `20260907220528`, plus `20260907221210`
restating two grants for the branch gate), one engine change,
two law tests. Every figure below was read from production at the time
stated; nothing is rounded for narrative.

## What Phase 6 was briefed to be, and what it turned out to be

The brief: canonical rake attribution, a single rounding policy, double-entry.
The handoff's headline defect - "13.92% of all rake (153,046.44 / 98,350
rows in the week of 2026-08-31) attributable to nobody" - is not a defect.
Those 98,246 rows are tournament entry fees (registrations, rebuys,
satellite seats, spin settlements) with `player_contributions IS NULL`, and
`rake_attributions` never covers tournament rake at all. Tournament rake is
attributed at SETTLEMENT: `fn_settle_tournament_rake ->
fn_attribute_tournament_rake` credits VIP, agent commission and
`player_stats` by `metadata.user_id`, and coverage is complete (117,163
settlements, 587,261.01 of 592,171.58 lifetime tournament rake; 3 rows /
15.40 in the retry queue). The true cash unattributed population that week
was 355 rows / 714.53, all carrying contributions and already allocated by
`fn_rakeback_recompute_day`; the engine fix that mints the hand id
(`20260907195116`) took cash null-hand rows to 0 per hour from 20:00 UTC.

What the audit found instead were three places where the SAME rake was
attributed by two doors and two places where two formulas described one
number.

## 1. Tournament rake was attributed twice - VIP at 12.5x, commission at 2x

`fn_award_vip_points_from_rake` (trigger on `rake_records`) had a
`DEALT_EQUAL` branch that awarded the RAW `player_contributions` value - pot
contributions for cash, BUY-INS for spins - never the rake share. The written
rule (`20260831100610`, "rake paid is rake earned") says the credit is the
share of the rake. Measured:

| population                                 |   rows |       rake | VIP credit at insert |
| ------------------------------------------ | -----: | ---------: | -------------------: |
| spin entries, 2026-08-31..09-06            | 32,690 | 178,864.32 |         2,235,804.00 |
| cash DEALT_EQUAL, same week                |    530 |     999.15 |             2,576.00 |
| cash WEIGHTED, 09-06 12:00-18:00 (control) | 12,152 |  22,433.93 |            22,413.11 |

And every tournament row was credited AGAIN, correctly, at settlement (200
spins: 1,207.68 rake -> 15,096.00 at insert + 1,207.68 at settlement).

The engine had the same shape for agent commission: `RakebackSettlerService`
walked every row with contributions and paid `credit_agent_commission_from_rake`
per row (`source_type = 'tournament_fee'`, added 2026-07-24, before
`fn_attribute_tournament_rake` existed on 2026-08-27). Spin books carry
contributions since 2026-09-02, so: 6,753 spins settled on 2026-09-05
carrying 38,922.72 of rake earned agents 23,263.81 per-row AND 26,742.03 at
settlement; 90,396.99 of `tournament_fee` commission in the week of 08-31.
`player_stats` was applied from both doors too.

**Fixed.** `20260907214446`: the trigger skips tournament rows and takes
every method's shares from `fn_allocate_rake_credits` (probed: a tournament
row awards nothing at insert; a DEALT_EQUAL cash row with contributions
100/300 and rake 1.00 credits 0.50/0.50; WEIGHTED credits 0.25/0.75 - all
rolled back). Live since 21:46:09 UTC: zero tournament rows credited at insert
in the 25 minutes after, 1,672 cash rows credited 3,243.84 on 3,253.86 of
rake. Engine: `isTournamentRakeRow()` gates the commission and player_stats
loops; the `tournament_fee` source is gone;
`server/src/services/TournamentRakeIsAttributedOnce.law.test.ts` pins it.
Deploys on merge.

**Left with the players and agents** (CLAUDE.md 10.9 rule 3): the
over-awarded VIP points and the doubled spin commissions. Recorded as a
resolved `financial_alerts` row (`fn_award_vip_points_from_rake.contribution_not_share`).

## 2. The invoice described a different basis from the one round 1 pays

Dan's ruling of 2026-09-03 (roadmap decision 4b): a club's share is the rake
ITS PLAYERS generated - cash by the seat played (`ca_union_rake_attribution`),
tournaments by the registration club (`tournament_players`). Round 1 pays on
that. The statement (`fn_union_club_invoice -> fn_union_eco_adjustment ->
fn_union_reconciliation_report -> fn_union_rake_paid_readonly`) attributed
every player's rake to the club of their EARLIEST `club_members` row. Nothing
written says that. One identical window, 2026-08-31 07:00 .. 09-07 07:00 UTC:

| club       | statement basis (first-joined) | round-1 basis (seat played) |
| ---------- | -----------------------------: | --------------------------: |
| Club JAQK  |                      14,951.19 |                  285,808.43 |
| SHARK CLUB |                     633,214.79 |                  290,063.13 |

Same 645,382.63 of treasury credits, carved two ways. (The handoff's
6.4 figures were the same divergence with the columns swapped.) This is why
`weekly_invoices_enabled = 0`.

**Fixed.** `20260907215753`: `fn_union_club_rake_basis(union, from, to)`
returns `(club_id, game_type, rake_in, rate, payout)` - the round-1 block,
lifted out unchanged. Round 1 reads it and stores `basis_detail` and
`payout_by_club` in `ca_settlements.totals`; the statement, the ECO
adjustment and the reconciliation report read the SAME function, and for a
closed period the function returns the settlement's stored rows (the witness)
rather than recomputing. `rakeback_due` on the statement is now round 1's
payout to the cent. Proven inside the migration: for the window above the
function returned the identical 10 `(club, game type)` rows the old block
returned, and every statement line equals those rows summed. The cascade's
gate message no longer claims a disagreement.

**Not changed.** `weekly_invoices_enabled` stays 0. Switching statements
back on is a setting now, not a fix, and it is Dan's (section "Decisions").

## 3. Rounding: written down and enforced at the write

Five functions rounded five ways (`round(_,2)`, integer cents, the
pre-Phase-5 payer's `round(_,4)` - 933 of 2,704 `rakeback_period_payouts`
rows still carry sub-cent amounts - and the union close's `trunc`). Measured
over nine money columns and 1,363,000 rows in 24 hours: zero sub-cent values.
The policy was already the practice.

`20260907220528`: `fn_money_rounding_policy()` returns the rule as data
(unit / shares / rates / sums / vip / conservation), and `ck_whole_cents`
CHECK constraints on `rake_records`, `rake_attributions`, `agent_commissions`,
`union_wallet_transactions`, `club_wallet_transactions`, `chip_ledger`,
`rakeback_period_payouts`, `rakeback_periods`, `settlement_invoices` refuse a
sub-cent write from the migration's timestamp on (NOT VALID: no table scan,
no long lock; historical rows are never refused an update). A guard at the
write, not a sweep that reads it back later (10.12). Probed: a 0.123 rake row
is refused. `tests/money-is-whole-cents.law.test.ts` pins the migration, the
nine tables and the TS allocator's exact-sum property.

## 4. One hand, one record in the rakeback basis

2,574 null-hand `rake_records` rows are ghost twins of hands that also have
a linked row (Midway Union 2,239 / 6,758.65; Deep Stack Society 239 /
442.70; Club JAQK 61 / 217.77; SHARK CLUB 35 / 94.93; 7,514.05 of rake), and
EVERY one carries contributions. `20260907200330` left them alone on the
reasoning that "nothing per-player reads them". `fn_rakeback_recompute_day`
reads them: a null-hand row goes through the allocator, so each of those
hands counted twice in the player rakeback basis, and the VIP trigger fired
twice. The recompute now skips a null-hand row whose linked twin exists
(probed on Midway 2026-09-01: `rows_seen` fell by exactly the twin count,
rolled back). Paid weeks are immutable and stay paid; pending periods pick
it up on their next pass. Recorded as a resolved alert
(`fn_rakeback_recompute_day.ghost_twin_counted_twice`).

## 5. Double-entry - deliberately not built in this phase

`chip_ledger` already carries from/to legs on the union close, the treasury
rake leg and the club credits, and `fn_settlement_conservation_check()` is at
0 breaches. A full journal (every wallet movement as two balanced legs with a
trial balance) touches every money writer on the platform and is the most
invasive item in the brief with the least urgency; four other agents shipped
into this database during this phase alone. It belongs in Phase 8 (Control)
next to approve-before-execute, where a journal has a reader. Saying so here
rather than half-building it.

## Verification block for the next agent

```sql
with chk(n,k,v,expect) as (values
 (1,'vip trigger skips tournament rows', (select (prosrc like '%NEW.is_tournament%' and prosrc not like '%jsonb_each_text%')::text from pg_proc where proname='fn_award_vip_points_from_rake' and pronamespace='public'::regnamespace),'true'),
 (2,'round 1 reads the one basis',      (select (prosrc like '%fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end)%')::text from pg_proc where proname='fn_union_weekly_rakeback_close' and pronamespace='public'::regnamespace),'true'),
 (3,'statement reads the one basis',    (select (prosrc like '%fn_union_club_rake_basis%')::text from pg_proc where proname='fn_union_eco_adjustment' and pronamespace='public'::regnamespace),'true'),
 (4,'nine whole-cent constraints',      (select count(*)::text from pg_constraint where conname='ck_whole_cents'),'9'),
 (5,'recompute skips ghost twins',      (select (prosrc like '%ONE HAND, ONE RECORD%')::text from pg_proc where proname='fn_rakeback_recompute_day' and pronamespace='public'::regnamespace),'true'),
 (6,'no tournament VIP at insert (1h)', (select count(*)::text from rake_records r join vip_points_ledger v on v.source_id=r.id and v.source_type='rake' where r.is_tournament and r.created_at >= now()-interval '1 hour'),'0'),
 (7,'conservation breaches',            (select count(*)::text from fn_settlement_conservation_check()),'0'))
select n,k,v,case when v=expect then 'PASS' else 'FAIL expected '||expect end from chk order by n;
```

Row 8, after the engine deploys: `select count(*) from agent_commissions
where source_type='tournament_fee' and created_at > '<deploy time>'` must be 0.

## Decisions - taken 2026-09-08 (Dan: "this is for you to decide")

All three decided and shipped; see
`docs/changelog/2026-09-08-phase-6-verification-and-the-three-decisions.md`.
The options as they stood on 2026-09-07 are kept below for the record.

1. **Switch statements back on?** `weekly_invoices_enabled` is 0 for Midway.
   The basis is unified; the next close (2026-09-14 07:00 UTC, the first
   week above the floor) would issue statements that equal what round 1
   paid. Recommendation: set it to 1 before 09-14 so the first clean week
   gets a statement. `select fn_union_setting(...)` / the union settings UI.
2. **Do MTT entry fees earn player rakeback?** Today spin books do (they
   carry contributions) and MTT registrations, rebuys and satellite seats do
   not (103,224.75 + 5,949.30 + 8,475.50 in the week of 08-31). That is an
   accident of which writer fills `player_contributions`, not a rule. Either
   answer is defensible; it sets what players are owed in future, so it is
   yours. Recommendation: decide it once; if "yes", the writers set
   `player_contributions = {user: fee}` and nothing else changes.
3. **The phantom treasury credits from the ghost twins.** Each twin's call
   credited the union rake wallet (Midway/JAQK/SHARK: 7,071.35) or the club
   treasury (Deep Stack: 442.70) a second time for rake no pot paid twice.
   That is supply in a treasury, not a player balance. Recommendation: a
   ledgered burn to `chip_retirement` at the epoch reset (roadmap gate step 3),
   one row, with these figures; not corrected here.
4. Everything in the handoff's section 11 still stands (Midway funding
   280,142.41 vs 0.50; `union_club_terms` empty; 263 no-membership earners;
   Deep Stack's union status; CV; the 441,230.51 incident).
