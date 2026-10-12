# tests/the-diamond-cash-rake-is-swept-to-the-house-every-hour.law.test.ts

Diamond cash rake accrues player-side on every hand and reaches the house only
when fn_ca_diamond_sweep_cash_rake runs, the periodic sweep of design R4.
Migration 20261007034146 runs it every hour at :14 UTC (ruling 26). The law
fails if the job's name or minute changes, if the minute falls in the :50-:03
break window, if the command loses its own statement_timeout, its advisory
lock or the freeze gate before the sweep, if the proof stops checking exactly
the scheduled command, the arena switches and the Diamond identity, if the
file writes an arena switch or calls the sweep itself, or if the cron roster
and ruling 26 stop naming the same job and minute.
