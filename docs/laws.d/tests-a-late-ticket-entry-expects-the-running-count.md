# tests/a-late-ticket-entry-expects-the-running-count.law.test.ts

The ticket door (fn_ca_register_for_tournament_with_ticket_for) expects the field count the roster trigger leaves: one more before the start, unchanged once RUNNING (20261012031813), the same rule the wallet doors hold. Without it every late ticket entry was refused with a code PostgREST re-ran without end, which exhausted the database pool on 2026-10-11 from 17:50 to 18:53 UTC. The law also refuses any later migration that raises a custom 40001.
