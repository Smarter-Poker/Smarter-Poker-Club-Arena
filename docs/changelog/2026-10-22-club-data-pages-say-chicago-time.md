# 2026-10-22 - Club Data and Union Data pages count Chicago days

The client half of `2026-10-22-club-data-chicago-days.md`. The database now
buckets every Club Data and Union Data figure by the America/Chicago calendar
day (DST aware) and reports MTT Winnings for finished MTTs only, with a
separate `running_mtt_entries`.

- `src/lib/clubDataDay.ts` is the one clock for these pages: `chicagoDay()`
  (today's Chicago date), `chicagoClock()` and `chicagoStamp()` for printed
  times, and zone-free calendar arithmetic.
- Club Data (`ClubDataSimplePage`), the full report (`ClubDataPage`) and Union
  Data (`RakeSnapshotPanel`, `periodToRange`) ask for Chicago days: Day,
  Yesterday, Week, Month, Quarter, Year, Custom and the previous-period
  comparison. The range chip reads "Chicago Time", and every printed time is
  on the Chicago clock.
- The basis line reads "Net Entries And Payouts In Chicago Time. MTT Winnings
  Count Finished MTTs Only." when the server says `chicago_net_money_flow`; a
  page still served by the old database keeps its old line.
- Running MTT Entries are shown under the four totals on Club Data, beside MTT
  Winnings on the full report and on Union Data.

Tests that computed "today" as the UTC date now use the Chicago date, and the
period tests pin the Chicago rule, including both DST changes.
