# Weekly union accounting records actual failure

The weekly cascade previously returned failure after posting earlier stages. The scheduler discarded that result and pg_cron reported a successful statement. Player periods booked under the union house-club could be invisible to the member-club payout join.

Migration 20260914110557 was applied through Supabase on 14 September 2026. It preserves existing signatures, paid receipts, delivered invoices and the explicit clean-data floor. Downstream failure raises and rolls back the current union attempt; the scheduled caller records the failure outside that exception block. Outstanding player records and undelivered member-club invoices prevent completion. The existing job runs at 04:00 America/Chicago with retries after maintenance and chronological recovery from its configured floor.

PostgreSQL fixture verification: 17 assertions passed. Actual changed function bodies executed; money-moving child functions were stubbed. No historical corrective payout was made. Full earning attribution, hierarchy agreements and immutable agent statements remain open audit items in docs/audits/2026-09-14-union-accounting.md.
