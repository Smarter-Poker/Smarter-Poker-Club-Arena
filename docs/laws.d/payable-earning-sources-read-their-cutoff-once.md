# tests/payable-earning-sources-read-their-cutoff-once.law.test.ts

accounting_payable_earning_sources reads each club's launch accounting cutoff once per query through fn_ca_launch_accounting_club_cutoffs() and joins it with the per-row helper's exact predicate, instead of calling the SECURITY DEFINER fn_ca_launch_accounting_accepts on every row, so a week's sources fit inside the 240 s weekly close tick with identical rows.
