# tests/every-guard-has-a-reader.law.test.ts

A guard with no reader is not a guard (CLAUDE.md 10.86 rule 3). This law requires every `scripts/ci/check-*.mjs` to be referenced by an executable entry point, or be named in `MANUAL_TOOLS` with the reason a person runs it. Production drift checks run in `production-integrity-audit.yml`; it reports failures but never retries, reconciles, or publishes. Exit 2 ("could not ask") remains as loud as a detected mismatch.
