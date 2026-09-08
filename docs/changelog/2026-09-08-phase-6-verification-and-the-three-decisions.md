# Phase 6 verified adversarially, and the three decisions taken

2026-09-07 22:20 - 2026-09-08 02:25 UTC. Branch `fix/phase-6-verification`,
off `main` after PR #3553 merged (22:31 UTC; files verified on `origin/main`
by `git cat-file`, migration md5s verified against
`supabase_migrations.schema_migrations`). Engine deploy verified by outcome:
257 `tournament_fee` agent commissions in the 38 minutes before the merge,
zero in the two hours after. Three more migrations, applied and byte-matched:
`20260908020401`, `20260908021809`, `20260908021928`.

Dan: "do a deep dive and verify that everything you've built in the previous
phase is 100% fully built, coded, wired in and tested ... THIS IS FOR YOU TO
DECIDE WHAT TO DO, NOT ME."

## What the verification found in Phase 6's own work

Every item below was found by running the thing, not by re-reading it.

1. **A performance regression I shipped.** `fn_union_club_rake_basis`
   computes a full week from 251,895 treasury credits and 57,508 tournaments.
   Round 1 (two-minute budget) does not care; `fn_union_reconciliation_report`
   is callable by a signed-in union lead with an eight-second timeout and went
   from ~7 s to 31.5 s. Two indexes (built CONCURRENTLY; cash part 7.6 s to
   0.3 s) and a restructured tournament split (group credits per tournament
   before joining) brought a full week to 15 s - not enough. So the open week
   is snapshotted: `fn_union_rake_basis_refresh` stores the function's own
   rows in `union_rake_basis_snapshot` from the hourly integrity sweep (the
   sanctioned home for periodic union work), and every reader of an open
   window gets the snapshot (160 ms). Round 1 passes `p_live := true`, never
   reads a snapshot, and stores the witness as before. Proven in-migration:
   the live path equals the old block row-for-row for the 08-31 week, the
   snapshot equals a live computation through the same instant, the money
   report runs in budget. The remaining 7.8 s of the reconciliation report is
   `fn_union_pnl_all_clubs`, untouched by Phase 6 and already at the edge
   before it.
2. **A third basis.** `fn_union_money_report` (rewritten by another agent at
   21:08 while Phase 6 was in flight) computed "rake this week / what each is
   owed at the next close" by the HOSTING club with a flat rate. It reads the
   one function now.
3. **A guard in the wrong place.** Only the cascade honoured the settlement
   floor and `weekly_invoices_enabled`; `fn_union_issue_weekly_invoices` did
   not, and the Open Claw safety net (`/api/club-arena/union-invoice?action=send`,
   Mon 13:00 UTC) calls the function directly. It also issued "rakeback
   already moved in chips" for a period whose round 1 had not run. Three
   guards now live in the function: floor, gate, and a final close for
   exactly that period.
4. **The ghost-twin rule was too loose.** Hand numbers below 1,000,000
   recurred per table before 2026-07-31. Of 2,574 loose twins, 2,478 carry a
   global number and match one linked row; 96 do not and are not provably the
   same hand. The rule now requires a global number, lives in ONE function
   (`fn_rake_record_is_ghost_twin`), and is read by both the recompute and the
   payer's cold fallback scan, which carried a second copy of the predicate.
5. **Unrecorded indexes.** Declared in the migration (IF NOT EXISTS).

Verified and left alone: the rewritten round-1 close run end to end in a
rolled-back transaction with the floor lifted inside the subtransaction
(success, conservation asserted, 10 basis rows stored and served back by the
witness path, 518,284.36 paid = detail sum, 2 statements exact);
`ck_whole_cents` refused nothing legitimate in 4 hours (3,860 rake rows,
12,568 ledger legs, 6,618 commissions written); the VIP trigger credited zero
tournament rows at insert; the 38 migrations other agents landed in the
meantime touched none of Phase 6's functions (guards held), though one now
inserts NEGATIVE `rake_records` rows on spin cancellation that
`fn_rakeback_recompute_day` (`rake_amount > 0`) does not net - noted, not
mine, and small.

## The three decisions (migrations 20260908021809 / 20260908021928)

**1. Tournament entry fees earn player rakeback.** A fee is rake: booked in
`rake_records`, paid to clubs at 90% per game type, attributed to the player
for VIP and commission at settlement. Only the player rakeback basis missed
it, because four of five tournament writers never fill `player_contributions`
(spin books do). Same 10% fee, one player earning rakeback and one not, is
the asymmetry 10.5 forbids. One rule at the source table
(`trg_tournament_fee_names_its_player`): `metadata.user_id` when the writer
names one, else an equal split across the field. Forward only; live: every
registration, rebuy and satellite row since carries contributions.

**2. Statements back on; the two stale ones credited in full.**
`weekly_invoices_enabled = 1` before the 09-14 close. MIDWAY-2026-000001
(JAQK, 7,531.11) and -000002 (SHARK, 220,615.68) were computed on a rake basis
no ruling supports and a horse-fleet P&L the platform cannot reproduce;
nothing is taken from a club for our defect. Credit notes MIDWAY-2026-000003/4
delivered to both clubs, outstanding 0, and `fn_union_age_invoices` run
against the opened gate sent nothing (rehearsed and rolled back first).

**3. The phantom treasury credits retired.** READ by matching both credit
rows per twin: Midway rake_wallet 1,171 twins / 3,245.35 (the earlier
estimate of 7,071 counted twins whose second call never credited); Deep Stack
treasury 239 / 442.70. Retired through `fn_ca_burn` (keyed chip_retirement
legs, `ca_mint_ledger` rows), the union's share first moved rake_wallet ->
bank with the close's own two-row transfer; both figures re-measured inside
the migration, which aborts if they move.

## Verification block for the next agent

```sql
with chk(n,k,v,expect) as (values
 (1,'basis has p_live',            (select count(*)::text from pg_proc where proname='fn_union_club_rake_basis' and pronargs=4),'1'),
 (2,'no 3-arg basis left',         (select count(*)::text from pg_proc where proname='fn_union_club_rake_basis' and pronargs=3),'0'),
 (3,'close computes live',         (select (prosrc like '%fn_union_club_rake_basis(p_union_id, p_period_start, p_period_end, true)%')::text from pg_proc where proname='fn_union_weekly_rakeback_close'),'true'),
 (4,'sweep refreshes snapshot',    (select (prosrc like '%fn_union_rake_basis_refresh%')::text from pg_proc where proname='fn_union_integrity_sweep_all'),'true'),
 (5,'snapshot fresh (<3h)',        (select count(*)::text from union_rake_basis_snapshot where computed_at > now()-interval '3 hours'),'1'),
 (6,'money report reads basis',    (select (prosrc like '%fn_union_club_rake_basis%')::text from pg_proc where proname='fn_union_money_report'),'true'),
 (7,'statement guards',            (select (prosrc like '%before_settlement_floor%' and prosrc like '%weekly_invoices_disabled%' and prosrc like '%period_not_closed%')::text from pg_proc where proname='fn_union_issue_weekly_invoices'),'true'),
 (8,'one ghost rule',              (select (prosrc like '%fn_rake_record_is_ghost_twin%' and prosrc not like '%AND EXISTS (SELECT 1 FROM rake_records l%')::text from pg_proc where proname='fn_rakeback_recompute_day'),'true'),
 (9,'payer fallback uses it',      (select (prosrc like '%fn_rake_record_is_ghost_twin%')::text from pg_proc where proname='fn_close_settlement_period'),'true'),
 (10,'fee rule on the table',      (select count(*)::text from pg_trigger where tgname='trg_tournament_fee_names_its_player'),'1'),
 (11,'gate open',                  fn_union_setting('fade0000-0000-0000-0000-000000000001','weekly_invoices_enabled',1)::text,'1'),
 (12,'stale statements at zero',   (select count(*)::text from settlement_invoices si where invoice_number in ('MIDWAY-2026-000001','MIDWAY-2026-000002') and fn_union_invoice_outstanding(si.id)<>0),'0'),
 (13,'two retirements',            (select count(*)::text from ca_mint_ledger where op_id like 'phase6:ghost-twin-phantom:%' and action='burn'),'2'),
 (14,'no tournament_fee commission (24h)', (select count(*)::text from agent_commissions where source_type='tournament_fee' and created_at > now()-interval '24 hours'),'0'),
 (15,'conservation breaches',      (select count(*)::text from fn_settlement_conservation_check()),'0'))
select n,k,v,case when v=expect then 'PASS' else 'FAIL expected '||expect end from chk order by n;
```

Row 14 is true from 2026-09-08 onward (the engine deployed ~22:40 UTC 09-07).

## Still open, and whose

- `fn_union_pnl_all_clubs` at 7.8 s for the open week puts the reconciliation
  report at the 8-second edge on its own. Pre-existing; Phase 7 (performance)
  territory.
- Spin cancellation reversal rows (negative `rake_records`, another agent, 20260907223105) are not netted out of the rakeback basis. Small; not mine.
- Double-entry stays in Phase 8, as the Phase 6 changelog said.
- Everything in the original handoff's section 11 that is Dan's (Midway
  funding, `union_club_terms`, the 263 no-membership earners, Deep Stack's
  union status, CV, the 441,230.51 incident) is still his.
