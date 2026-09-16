# Cash seeding stops obsolete reads

When shutdown withdrew a horse-fleet generation, its paginated reads could
continue through later pages and timeout retries. One ordinary page can take
three 15-second attempts, already longer than the process's 40-second shutdown
deadline. The fleet only checked its generation before starting the cycle.

The pagination helper now accepts an optional continuation check. It checks
before each request and after joining its response. Withdrawal returns the
previously collected rows as incomplete, without accepting a late response or
starting another page or retry. Existing callers retain their prior behavior.

The cash seeding cycle passes its captured generation to all fourteen paginated
reads: ten setup reads, the late door read, and the human queue, horse queue,
and seat-offer helpers. Setup stops before acting on withdrawn reads. A late
door withdrawal exits the seating loop through its existing bookkeeping path.
The queue helpers stop admitting subsequent clear batches or offers. The cycle
still owns its final status write and reports `lifecycle_stopped`.

This does not detach an in-flight operation, cancel a money transaction, change
the shutdown deadline, or release engine ownership. The public fleet-health
query remains independent of the seeding lifecycle.

Nine original-source failures cover pagination withdrawal and the real fleet
stop/final-write sequence. Three additional original-source failures cover the
dependent queue and offer readers. Existing pagination, ownership, finalizer,
policy, and complete-floor tests remain part of validation.

The retained 13:55 production archive shows unfinished producer stops before
the fatal shutdown deadline. This repair closes a reproduced source defect in
one of those producers. It does not establish that this was the only cause of
that shutdown failure; installation and a clean production shutdown remain
separate acceptance requirements.
