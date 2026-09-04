# server/src/maintenance/theFreezeIsTotal.law.test.ts

The freeze is total (Dan 2026-09-01/03): the break is adopted before any service that can seat a player; every horse seat / registration / launch path is gated on isMaintenanceFrozen(); the break is idle before the first table is woken; and the DB backstop (fn_refuse_new_entries_while_frozen) refuses new cash seats, registrations and launches for every role, bypass excepted
