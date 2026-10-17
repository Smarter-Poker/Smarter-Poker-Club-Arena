# Mobile natural proof reads candidate-table history

The natural two- and three-run observer timed out before opening its tables because discovery read recent hand history globally. Discovery now reads only the occupied candidate tables through the existing `(table_id, created_at, id)` index, with four concurrent requests and at most 32 candidates. The recent-time range and both run counts remain unchanged.

Focused regression coverage rejects global reads and invalid candidates, retains both run counts and propagates database failures. River timing, every winning recipient, chip landing, live identity and coverage assertions remain required. No runtime, schema or financial behavior changes.
