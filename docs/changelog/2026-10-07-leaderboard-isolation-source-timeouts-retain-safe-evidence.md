# Leaderboard Isolation Source Timeouts Retain Safe Evidence

Two current-schema preflights timed out during schema-only export before reaching destination restoration. The unchanged export had completed in a predecessor; no timeout cause is yet established.

The maintained source failure path now reports the actual client status, numeric elapsed time or explicit unknown, and only the exact owned container's allowlisted state, exit code and OOM flag. Inspection is bounded to ten seconds and unavailable or malformed readback remains unknown. It never emits raw errors, SQL, connection strings, environment or container logs. Status 124 denotes the outer timeout; status 137 is signal termination, not automatically a timeout. Server statement and lock cancellation receive separate fixed categories.

The same source image, read-only connection, export options, 300-second export bound, original owners and versions, exact catalog comparison and verified cleanup remain unchanged. Focused contracts exercise the maintained failure helper and redaction boundaries. This improves diagnosis only; it does not certify restoration, authorization or financial behavior. Actual qualification and safe cleanup remain required before completion.
