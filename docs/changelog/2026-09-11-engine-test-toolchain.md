# Patched engine test tooling

This is the separately scoped development-tool repair following the runtime
dependency patch at `669df6af0c5b704d857018ba950fc280eee47560` (#4337). The
server's Vitest 2.1.9 dependency tree retained critical/high development-server
findings after the production tree was repaired. The complete server dependency
audit now reports **zero findings**, including development dependencies.

| Tool             | Previous lock | New lock |
| ---------------- | ------------- | -------- |
| Vitest           | 2.1.9         | 4.1.11   |
| Vite             | 5.4.21        | 6.4.3    |
| tsx              | 4.21.0        | 4.23.13  |
| esbuild for tsx  | 0.27.3        | 0.28.2   |
| esbuild for Vite | 0.21.5        | 0.25.12  |
| nanoid           | 3.3.11        | 3.3.19   |
| postcss          | 8.5.9         | 8.5.28   |

Vite is now an explicit server development dependency constrained to the
repository's existing 6.4 series, which Vitest 4.1.11 supports. This avoids
implicitly adopting another Vite major while upgrading the test runner. The
compatible nanoid/postcss lock updates remove the remaining high findings.
The same-major tsx update removes its esbuild Windows development-server finding.
No `npm audit fix`, force, peer-dependency bypass, or dependency override was used.

Vitest 4 makes mock call/constructor types more precise. Five test files now
declare the actual callback, queue or console-spy types rather than generic
`ReturnType` types that also admit constructors. Assertions, test cases, timeouts,
mock behavior, and production TypeScript source are unchanged. The existing
Node-only configuration and `src/**/*.test.ts` discovery remain unchanged;
UI, browser and API-server modes remain off.

The upgrade was checked against the official [Vitest 4 migration guide](https://github.com/vitest-dev/vitest/blob/v4.1.11/docs/guide/migration.md),
[Vitest 3 migration guide](https://v3.vitest.dev/guide/migration.html), and
[Vitest 4.1.11 release](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11).
Relevant security records include the [Vitest UI advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp),
[mocker redirect advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
and [esbuild Windows advisory](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr).

## Validation and limits

- Native Node 22.23.2/macOS arm64: full server suite **688 passed / 1 skipped
  files; 9,799 passed / 145 skipped tests**, matching #4337's test discovery and
  existing skips. TypeScript build passed.
- A temporary deliberately failing assertion returned exit 1 and was removed.
  Passing migration results therefore do not depend on ignored assertion failures.
- Old and new tsx executed the same real TypeScript equity PRNG and configuration
  imports with identical output. Config readback showed Node environment and
  UI/API/browser disabled; none of those optional browser/UI packages were added.
- All **49 production package version/URL/integrity identities** match #4337.
  A separate fresh production-only install succeeded and excludes Vitest, Vite,
  tsx and their development tooling.
- npm 10.9.8's update resolver crashed internally while inspecting optional peer
  packages. The installed npm 11.16.0 generated the lock without bypass flags;
  a clean Node 22/npm 10.9.8 `npm ci` then succeeded. The existing production
  install/build/test route remains supported.
- This is a held source candidate. No Linux image, host installation, production
  change or served-release certification is claimed.

Exact source, dependency and validation fingerprints are in
[`evidence/2026-09-11-engine-test-toolchain.json`](evidence/2026-09-11-engine-test-toolchain.json).
