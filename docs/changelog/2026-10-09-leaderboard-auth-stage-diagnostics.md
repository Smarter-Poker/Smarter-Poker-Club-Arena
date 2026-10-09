# Isolated leaderboard Auth failure stages

The changed sequence exporter passed its actual hosted native fixture and advanced through export and restored catalog checks in run37883433916. The Auth launcher then failed without identifying its stage. It now reports a closed stage name and timeout/exit/assertion category while preserving suppression of Docker output, environment values, synthetic passwords and issued tokens. No Auth, SQL, permission, timeout budget or financial assertion changes are made.

The diagnostic regression exercises allowed categories and rejects arbitrary secret-shaped inputs. Actual Auth and all financial qualification remain pending; this change is diagnostic recovery preparation, not a passing qualification or production financial installation.

A real socket-only PG17.11 reproduction established a launcher defect: restarting without an explicit log file left descendant output pipes open, so a captured process reached its 3-second bound despite a healthy database and exit status0. The same restart with explicit logging completed in214ms, followed by verified healthy readback, smart shutdown and scratch removal. The launcher now uses its existing private `/tmp/postgres.log` and rejects process errors even when exit status is0. This fixes the reproduced mechanism; it does not establish the exact cause of the hosted failure or qualify Auth.
