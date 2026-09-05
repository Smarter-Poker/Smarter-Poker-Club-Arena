# 2026-09-05 - P0 hotfix: every table crashed on the published build

Opening any table on `ca_sha 63baa151` threw "Cannot access 'parseTimed'
before initialization" into the error boundary. #3089 made `anyTurnLive` in
MultiTablePage read `parseTimed(t.decision)` during render, and `parseTimed`
was a `const` declared further down the component body: a use-before-declare
inside a nested callback, which tsc does not flag and no test rendered.
`parseTimed` is a pure function at module scope now.

Reproduced on an unminified local build of `main` (the table route landed on
the error boundary) and confirmed fixed the same way. New law
`tests/no-tdz-in-table-route.law.test.ts`: `no-use-before-define` over
MultiTablePage, TablePage and TableModalsLayer as a ratchet against a baseline
of deferred-callback references, so the shape cannot ship again unnoticed.
