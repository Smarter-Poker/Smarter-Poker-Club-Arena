# tests/every-installing-job-skips-a-warm-install.law.test.ts

Every job that restores a node_modules cache guards its `npm ci` on the cache hit. `npm ci` DELETES node_modules before installing, so an unguarded install makes the restore pure cost - and takes the warm `.vite` and `.tsbuildinfo` riding inside it too. CSS Beat E2E, the critical path, did exactly that; its three sibling jobs had carried the guard since 2026-09-01
