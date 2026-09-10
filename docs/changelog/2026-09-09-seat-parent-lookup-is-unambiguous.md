# Seat Parent Lookup Is Unambiguous

Phase 3 live acceptance reproduced a Shark lobby seat-state read failure on September 9, 2026. Production has three foreign keys from table_seats to tables. The unqualified tables(tournament_id) embed returns HTTP 300 PGRST201 before it can read the player seat state.

The lobby now names table_seats_table_id_fkey, preserving the historical table relationship and tournament-id mapping. Ownership filtering and the existing retain-previous-state-on-error behavior are unchanged. The existing seat-first regression assertion names the explicit relationship. No database constraint, balance, seat or deployment protection is changed.

Final authenticated production recheck follows publication. Anonymous access is not an acceptance substitute.
