# tests/a-terminal-close-marker-may-stamp-unregistration-evidence.law.test.ts

An event holding a committed unregistration fee reversal must still be able to complete: `fn_ca_unregistration_rake_evidence_is_immutable` admits exactly the terminal close marker (NULL to the event's own `ended_at`, nothing else changed, through `fn_ca_terminal_marker_transition_is_exact`, as every sibling rake guard does) and keeps refusing every other update and every delete of that evidence with the same message and SQLSTATE.
