# Isolated leaderboard Auth failure stages

The changed sequence exporter passed its actual hosted native fixture and advanced through export and restored catalog checks in run37883433916. The Auth launcher then failed without identifying its stage. It now reports a closed stage name and timeout/exit/assertion category while preserving suppression of Docker output, environment values, synthetic passwords and issued tokens. No Auth, SQL, permission, timeout or financial assertion changes are made.

The diagnostic regression exercises allowed categories and rejects arbitrary secret-shaped inputs. Actual Auth and all financial qualification remain pending; this change is diagnostic recovery preparation, not a passing qualification or production financial installation.
