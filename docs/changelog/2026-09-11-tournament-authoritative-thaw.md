# Tournament clocks wait for the authoritative thaw

The former 90-second maintenance wait resumed synchronized tournament breaks
even when the global freeze remained active. A release tail can exceed that
duration. The wait now reports once and keeps the break until the authoritative
thaw; a stopped lifecycle still exits promptly without clearing the next owner's
break state.

Restart adoption also retains an expired synchronized countdown while maintenance
remains frozen. It preserves the remaining play time without arming a blind
timer or rewriting the durable level anchor. Without a maintenance hold, normal
elapsed time after the recorded break still counts.

The actual TournamentManagerBase lifecycle tests exercise both short and
15-minute holds and fencing. Restoration tests cover expired countdown adoption,
repeated restart, exact remaining time and one resume. These regressions address
synchronized-break behavior; separate operation-maintenance manager integration
and production qualification remain required.
