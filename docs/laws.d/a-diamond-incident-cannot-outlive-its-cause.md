# tests/a-diamond-incident-cannot-outlive-its-cause.law.test.ts

Forty-five DR0:health_critical rows sat open in ca_diamond_incidents on
2026-09-19, filed hourly between September 9 and 11 by
fn_ca_diamond_health_watch. Every cause they named had read ok since September
11 at 16:35 UTC, and eight DR11:trial_balance_break warnings from the same
day were open with the trial balance at zero on every account since. Nothing
in the estate resolved a DR0 row: the watch filed and never wrote resolved_at,
and the only automatic resolution was the trial balance watch's seven-day sweep
of info rows. The programme's public-release condition reads "no open critical
ca_diamond_incidents", so a condition that cleared eight days earlier kept the
gate literally unmet.

Migration 20260919223032 puts the resolution where the filing is. The health
watch, after filing exactly what it files today, resolves every open DR0 row
whose named areas all read something other than critical or unknown on this
tick, with a note naming each area and what it read; a row with any area still
critical stays open, a row naming no area is left for a person, and a report
that came back empty clears nothing. The trial balance watch resolves an open
DR11 break when its account reads difference 0 and an open DR12 suspense row
when suspense reads 0. A new nullable resolution column records why a row was
resolved and by what, so an automatic resolution is never mistaken for a human
ruling. Nothing is deleted beyond the thirty-day housekeeping of resolved info
rows the trial balance watch has always had, no other rule is touched, and the
chip estate's financial_alerts is not involved.

The law reads the migration with its comments stripped and pins: that the
newest definition of each watch carries the resolution; that DR0 rows are
resolved by every area on the row; that DR11 and DR12 rows are resolved by the
account that now reads zero and NULL clears nothing; that the one DELETE is
the unchanged thirty-day sweep; that both bodies are md5-pinned before they
are replaced; that the migration runs one tick by the deployed code and refuses
to commit while a critical cause is still present; and that neither watch is
executable by anon or authenticated.
