-- A LEAGUE MATCHUP THAT IS NOT MEASURED SAYS WHY (2026-09-27)
--
-- horse_league_results could express "the layer won 0.4 bb/100" and it could
-- express "the layer won exactly nothing", but it had no way at all to say
-- "this question was not asked tonight, and here is why not".
--
-- That gap had a cost. Three matchups - v16_ratio_rescale (2026-09-05),
-- v31_gto_suit_aware and v18_exploit_size (both 2026-09-01) - were retired by
-- COMMENTING THEM OUT of LEAGUE_MATCHUPS, which removes the row entirely.
-- fn_audit_nightly_job_health raises league_matchup_inert only from rows
-- WHERE hands > 0, so a matchup with no row is invisible to the detector
-- built to catch exactly this shape. The reasoning survived only in source
-- comments, which no query reaches.
--
-- The audit then argued with the source and lost: league_card_stale still
-- recommends fixing the runner so v16_ratio_rescale can satisfy "any
-- three-run gate", 22 days after that matchup stopped running. The v16Ratio
-- decision could not move in either direction, because nothing in the
-- database admitted the experiment had been stopped.
--
-- So the refusal becomes a row, and the three states become distinguishable:
--   measured - hands > 0, a real result
--   inert    - hands > 0 but the arms played identically: a HARNESS FAULT
--   refused  - hands = 0, deliberately not asked, reason attached
alter table public.horse_league_results
  add column if not exists status text not null default 'measured',
  add column if not exists refusal_reason text;

comment on column public.horse_league_results.status is
  'measured | inert | refused. inert is a harness fault (the two arms played identically over real hands); refused means the league deliberately did not ask, with refusal_reason saying why.';
comment on column public.horse_league_results.refusal_reason is
  'Required whenever status <> measured. For refused rows: why the league cannot answer, when it last could, the divergence probes, and what would change the verdict.';

alter table public.horse_league_results
  drop constraint if exists horse_league_results_status_chk;
alter table public.horse_league_results
  add constraint horse_league_results_status_chk
  check (status in ('measured', 'inert', 'refused'));

-- A non-measured row without a reason is the silent zero all over again.
alter table public.horse_league_results
  drop constraint if exists horse_league_results_reason_present_chk;
alter table public.horse_league_results
  add constraint horse_league_results_reason_present_chk
  check (
    (status = 'measured' and refusal_reason is null)
    or (status <> 'measured' and refusal_reason is not null and length(btrim(refusal_reason)) > 0)
  );

-- hands = 0 is what separates a judgement from a failed experiment.
alter table public.horse_league_results
  drop constraint if exists horse_league_results_refused_dealt_nothing_chk;
alter table public.horse_league_results
  add constraint horse_league_results_refused_dealt_nothing_chk
  check (status <> 'refused' or hands = 0);

-- Backfill the history so it reads honestly: 20 rows that recorded
-- 0.00 +/- 0.00 over real hands were never measurements.
update public.horse_league_results
   set status = 'inert',
       refusal_reason =
         'Backfilled 2026-09-27: recorded 0.00 bb/100 with 0.00 stderr over ' || hands ||
         ' hands. In a duplicate-deal harness the two arms differ only in the flag under ' ||
         'test, so an exact zero with zero variance means the flag changed no decision at ' ||
         'all. This row is the absence of an experiment, not a resolved zero, and must not ' ||
         'be averaged in with measurements.'
 where hands > 0
   and bb100 = 0
   and stderr = 0
   and status = 'measured';

create index if not exists idx_horse_league_results_status
  on public.horse_league_results (status, run_date desc)
  where status <> 'measured';
