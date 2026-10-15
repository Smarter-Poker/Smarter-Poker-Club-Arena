# Lightning Report Uses Full Engine Identity

The actual pilot report read the abbreviated engine `version` and incorrectly reported that a full revision was unavailable, although `/health.releaseSha` supplied it. The report now uses the full release SHA when present and refuses malformed or inconsistent identities. Its serving bracket detects a revision change even when both releases share the same short prefix. Legacy short-only health remains explicitly incomplete.

The production-shaped regression fails before repair and passes afterward. All 106 operator/access/report/setup checks pass. The report's real pilot NO_GO, unverified outsider access and unqualified launch gates remain visible; this change does not activate a game or install an engine.
