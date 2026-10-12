# The money conservation scan reads every event in one pass (2026-10-03)

Phase 5 of 9 (alerts reach a person, main CI green). Migration `20261003095111_the_money_conservation_scan_reads_every_event_in_one_pass`.

## What was wrong

`Cron Health` was red on main. `fn_ca_cron_health()` rated one job `critical`, meaning it had run and never succeeded:

- `tourney_money_conservation_deep_daily` (03:25 daily, 45 days) was cancelled on a statement timeout inside `fn_tournament_conservation_delta` on 10-03, 10-02, 10-01 and 09-29.
- Its last four nights therefore produced no 45-day conservation verdict.

The arithmetic was fine. The read was the problem: pass 2 of `fn_tournament_money_conservation` called the scalar once per event. There are 143,479 events in 45 days, at about 4 ms each, so the scan crossed the job's budget as the platform grew. The hourly 1-day pass (11,000 events, about 40 s) was heading the same way.

## What changed

- **`fn_tournament_conservation_deltas(p_since, p_until)`** returns the conservation delta of every event the scan covers.
  - It uses exactly the scalar's arithmetic, term for term, summed once per table instead of once per event.
  - Eligibility is the scan's own: COMPLETED or CANCELLED, ended inside the window, not `spin`, and with a buy-in.
  - It is `STABLE SECURITY DEFINER`, closed to `PUBLIC`, `anon` and `authenticated`, and executable by `service_role`.
- **Pass 2 of `fn_tournament_money_conservation`** now reads that function. Pass 1, which re-checks at most 1,000 open alerts by name, still asks the scalar.
- **Nothing else moves.** The report, the alerts, the ordering and the cap are unchanged. No job was added or rescheduled, no chips moved, and nothing was backfilled.

## Proof

- **Production, read only:**
  - The set-based read covered all 45 days (143,479 events) in 23.8 s.
  - It equals `fn_tournament_conservation_delta` on all 143,543 events checked, in five slices by id prefix: 0 differ.
  - A rolled-back `pg_temp` run of the successor scan (one MCP call ending in `RAISE`) scanned 143,694 events in 36.4 s. Its verdict was ok, with 0 flagged.
- **Native PG17.** `scripts/ci/fixtures/backed-payout-scan/conservation-set-native.py` runs after every earlier backed-payout qualification.
  - The installed scan (`conservation-scan-before.sql`, the live text) is the oracle.
  - The successor returns the same report and leaves the same alerts for seven window, tolerance and cap combinations, including pass 1 closing exactly the balanced alert.
  - Set and scalar agree on every event in the fixture population, and the set function selects exactly the scan's events. The eligibility edges cover cancelled, spin, free, fee-only, inside the 30-minute grace, ancient, and no end time.
  - The migration refuses a changed preimage (scan or scalar) and changed authority, rolls back whole, and refuses a second apply.
  - Function identity and grants are unchanged, and both functions refuse `anon` and `authenticated`.
- **Live.** Applied at 10:04 UTC as schema_migrations `20261003100457`, and the `@live-proof` is true. A real run of the deep pass, `fn_tournament_money_conservation(45, 1.0, 500)`, then finished in 69.0 s, scanning 143,771 events: ok, 0 flagged.
- **Law.** `tests/the-conservation-scan-reads-every-event-in-one-pass.law.test.ts` pins the migration. It also requires the set function to be redeclared whenever the scalar is, reading every literal the scalar reads. A change to the scalar that leaves the set function behind fails CI.
