# tests/server-scripts-are-type-checked.law.test.ts

`server/tsconfig.json` has `rootDir: src`, so the operator CLIs under `server/scripts/*.ts` were compiled by no CI job (2026-10-31). `server/tsconfig.scripts.json` type-checks them all, the Server Engine job runs it right after the server compile, and only `scripts/qualification/**` (vitest files with a recorded pre-existing baseline) may be excluded.
