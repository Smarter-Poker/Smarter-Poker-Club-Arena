# tests/a-late-ticket-entry-wakes-its-manager.law.test.ts

The ticket door (fn_ca_register_for_tournament_with_ticket_for) wakes the tournament manager with 'late_registration', a reason the wake door admits (20261012112543). It used 'late_ticket_registration', which fn_emit_tournament_manager_wake refuses, so every late ticket entry rolled back at its last step. The law also refuses any later migration that hands the wake door a reason outside its closed list.
