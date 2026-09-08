# Cancellation covers both aggregate Spin fee writers

Fresh function inventory found fn_spin_settle_game also books aggregate rake when entry booking has not done so. Both fn_spin_book_entry and fn_spin_settle_game have production records. The initial cancellation repair covered only the first writer.

The same original-row reversal now covers both sources and records the actual original source alongside original_rake_record_id and its contribution map. Expanded actual-function tests reproduce the omitted alternate writer and pass both writers, unchanged refunds, prior reversals, terminal replay and journal-failure rollback.

Migration 20260907223616 is deployed and its installed-function probe passed. External payment, reporting and escrow helpers remain outside this isolated test. Historical fee correction and complete Spin contribution/escrow reconciliation are still open.
