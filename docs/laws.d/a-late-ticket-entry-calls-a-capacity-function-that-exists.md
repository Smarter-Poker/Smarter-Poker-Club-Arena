# tests/a-late-ticket-entry-calls-a-capacity-function-that-exists.law.test.ts

No current function declaration calls the dropped fn_create_late_registration_capacity, and the ticket late-entry retry calls fn_ensure_late_registration_capacity(p_tournament_id,0) twice after inserting the registered entrant (it reserves no second entry), so a late ticket entry seats instead of rolling back with 42883 (2026-10-19).
