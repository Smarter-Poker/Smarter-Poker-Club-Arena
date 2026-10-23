# Union Data's window reader is planned with its values

After 20261022165130 the Union Data month view (Midway Union, Oct 1-22) still took
about 7 s against the 8 s browser statement timeout, so under load it could still
fail. Profiling on production put 4.9 s in `fn_ca_rake_windows_v3`, and within it
5.4 s (under EXPLAIN) in the MTT step: as a LANGUAGE sql function its statement is
planned with its arguments unknown, so the planner probed the window's rows once
for each of the 6,399 MTTs ever run. With the values known the same query takes
0.22 s.

Migration `20261023032335` keeps the statement text exactly (only `p_clubs`,
`p_start`, `p_end`, `p_per_club` become `$1`..`$4`) and runs it through
`EXECUTE ... USING`, so each call is planned for its own window. Read-only on
production, on closed Chicago days, old against new:

| Window | Old | New | Same result |
| --- | --- | --- | --- |
| Midway Oct 1-21, per club | 4.49 s | 2.38 s | yes |
| Midway Sep 16-Oct 21, union | 4.42 s | 2.48 s | yes |
| Midway Oct 8-21, per club | 2.65 s | 2.20 s | yes |
| Midway Oct 15-21, per club | 1.57 s | 1.57 s | yes |
| Midway Oct 21, per club | 0.27 s | 0.27 s | yes |
| KINGS CLUB, Deep Stack Society, The Felt Society, Oct 8-21 | | | yes |

"Same result" is identical jsonb apart from `data_updated_at`. Owner, security
definer, search path, work_mem and grants are unchanged; no table, index, trigger or
money changes.
