# Retired Runtime Cleanup

Removed obsolete tenant jobs, deployment configuration and certificates from
the live engine host after explicit user approval and a protected backup.
Renamed the OS and Hetzner display name to club-arena-engine, preserving its IP.
The engine container did not restart, public health returned 200, and all four
monitoring targets remained up.

Updated host documentation and removed the absent service from the TURN
installer's informational list. The installer still captures and verifies every
running service, and preserves Caddy, Docker and the engine container.

Validation: bash syntax check, diff review, live HTTP and monitoring checks.
No application TypeScript, database schema, or financial behavior changed.
