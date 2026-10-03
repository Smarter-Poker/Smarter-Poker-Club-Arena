# A silent Production Alerts reader reaches a person (2026-10-03)

Phase 5 of 9 (alerts reach a person). Migration `20261003102610_a_silent_production_alerts_reader_reaches_a_person`, live as schema_migrations `20261003102830`. The recorded text is byte-identical to the repo file.

## What was wrong

Since `20260916111614`, the owner's critical alerts are not pushed to his phone. This covers financial incidents, guarantee shortfalls, failed engine breaks and the daily digests. They are captured into `operational_alert_events` for the Production Alerts fleet, whose lanes read each event and write what they found into its `investigation`. That route has one reader, and nothing told anyone when the reader stopped.

Measured on 2026-10-03:

- **The reader stopped on 10-01.** The newest timestamp written into any event's investigation is 2026-10-01 20:02:05 UTC. The fleet's board, issue #5070, was last posted at 2026-10-01 16:37.
- **Eight owner alerts arrived after that and were read by nobody.** They include:
  - "KILL SWITCH: fn_ca_supply_snapshot read -100005.30" (10-02 15:05);
  - the -100,005.30, 200.00 and 0.01 ledger imbalances (10-02);
  - "More Chips Needed To Cover Guarantees" (10-02 11:02);
  - two estate digests and two chip-integrity attestations.
- **The push-deliverability light could not see it.** Since `20261002165500` it counts the route as live when the inbox _received_ a row, which says nothing about whether anyone _read_ it (CLAUDE.md 10.86 rules 1 and 3).

## What changed

The routing is unchanged.

1. **A read is a column.** `operational_alert_events.investigation_touched_at` is stamped by a trigger whenever a reader changes an event's `investigation` or `investigation_status`, which is the one thing every lane does when it reads. A partial index serves the newest stamp.
2. **A critical into a silent inbox pages once.** When a critical owner alert (`financial_incident`, `guarantee_bank_short` or `engine_break_failed`) is captured while nothing has been read for 12 hours, the owner gets one push titled "Production Alerts Has Stopped Reading". It says:
   - when the inbox was last read;
   - how many owner alerts have waited since;
   - the title of the newest one.

   The page is limited in three ways:
   - **One page per silence.** A later critical during the same silence does not page again.
   - **Never back into the dead inbox.** The page is an ordinary `system` notification, not an owner-operational type, so it goes through the normal push outbox and never into the inbox nobody is reading. The migration refuses to install if the classifier would divert that title.
   - **It cannot block a capture.** It runs in its own exception block, so it can never fail the capture of the alert itself.

3. **The last read is measured, never "now".** Until a reader writes its first stamp, the last read is the measured 2026-10-01 20:02:05. An unread inbox cannot look freshly read just because the column is new.

The page is event-driven, so no job was added or rescheduled. No chips moved.

## Proof

- **Rehearsal on production, rolled back.** One MCP call ending in `RAISE`. The page:
  - was not diverted by `fn_is_owner_operational_notification`;
  - reached `push_outbox` as `pending`, with the body "Nothing in the Production Alerts inbox has been read since 2026-10-01 20:02 UTC, and 8 owner alert(s) have arrived since.";
  - was not captured into the inbox.

  A second critical in the same silence was skipped.

- **Live.** The `@live-proof` is true, and `fn_undeclared_money_triggers()` is still 0.
- **Law.** `tests/a-silent-production-alerts-reader-reaches-a-person.law.test.ts` pins:
  - the read stamp and its WHEN;
  - the critical types, the 12-hour silence and the one-per-silence check;
  - the measured floor, the non-divertible title and the exception guard;
  - that there is no schedule.

## What this does not do

It does not restart the Production Alerts fleet, which is the owner's own process. It makes sure that when the fleet is not reading, the next critical reaches the owner instead of an inbox.
