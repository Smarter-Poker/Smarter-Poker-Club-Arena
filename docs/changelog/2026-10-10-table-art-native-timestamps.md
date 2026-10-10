# Table artwork accepts native database timestamps

The table-art row ordering guard now accepts PostgreSQL's native timestamp spelling with a space separator and an hour-only numeric offset, as well as the existing PostgREST ISO spelling. Supabase Realtime preserves `timestamptz` text. The previous parser rejected that supported input before applying a committed appearance event.

Normalization retains the explicit offset and all six fractional digits. Older rows and conflicting fields at the same version remain refused; missing zones and malformed timestamps remain refused. The same parser continues to govern live updates, cached first paint, and ALL-versus-game precedence.

The retained browser failure showed the saved red felt reaching both account channels while both tables remained green. Its artifact did not retain the event timestamp, so the format mismatch is an independently reproducible defect, not a proven reconstruction of that historical event. Fresh affected live verification remains required.

Regressions pass native values through the installed Realtime transformer, exercise multiple mounted tables, mixed native/ISO microsecond ordering and equal-version conflicts, cached precedence, and invalid-input refusal. No database, authorization, save transaction, or engine behavior changes.
