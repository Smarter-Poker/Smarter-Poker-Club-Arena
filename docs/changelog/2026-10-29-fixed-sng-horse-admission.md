# Fixed SNG satellite horse admission

The existing SNG tick services every nonempty or unknown-count fixed satellite before probing a bounded shuffled selection of empty boards. This preserves paid continuations across restarts instead of repeatedly omitting them from a random batch. Every automated roster registration reads the database's union-wide paid-admission plan before selecting horses. Refused or unreadable plans buy nothing; permitted counts preserve the final human seat until the persisted human window expires. Actual paid registration remains in the existing atomic horse entry door, with the database insertion guard owning concurrency and daily budgets.

Spin/Heads-Up seat admission and the scheduled MTT ten-minute ramp remain separate. Fixed satellites retain their full-field start, two seats, third-place refund and rounding remainder, and ten-percent rake.

Each union draws three to five opportunities per Chicago calendar day, spread randomly through separate parts of that day. The selected board and daily plan persist across restarts. Missed opportunities expire instead of accumulating, and only an actual paid horse entry consumes an opportunity. Existing paid boards retain their admission and count against their original day.

A new horse-assisted field keeps its last chair available for a random 120–150 seconds, leaving the existing 30-second tick time to finish filling it within the requested two to three minutes under normal processing. Humans can fill it immediately. Maintenance pause intervals extend an unfinished wait without reopening an already expired wait. The database guard shares the existing paid registration transaction, so a refused or failed purchase cannot retain a charge or consume another opportunity.
