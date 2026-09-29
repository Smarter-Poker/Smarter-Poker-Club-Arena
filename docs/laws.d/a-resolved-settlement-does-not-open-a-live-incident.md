# tests/a-resolved-settlement-does-not-open-a-live-incident.law.test.ts

fn_ca_financial_alert_to_incident fires AFTER INSERT ON financial_alerts and
raised a ca_drift_incidents row for every 'critical' alert, even one inserted
already resolved=true - a settlement migration's own audit proof of damage it
had already fixed. Being AFTER INSERT ONLY, the trigger could never revisit
that row, so the incident it opened sat open and kept re-escalating forever
for something already fixed. Pins that the trigger now returns immediately
when NEW.resolved is true, that the substitution still aborts loudly if the
function it targets has changed underneath it, that a second run of the
migration recognizes its own prior application, and that the three stray
2026-09-23 incidents raised from already-resolved rows
(tournament.blind_clock_burned_past_its_witness,
tournament.blind_clock_ran_while_stalled, tournament.stranded_event) are
resolved with a named root cause rather than silently.
