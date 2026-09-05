# tests/no-tdz-in-table-route.law.test.ts

No use-before-declare on the table route (2026-09-05, P0): `no-use-before-define` runs on MultiTablePage, TablePage and TableModalsLayer as a ratchet against a baseline of deferred-callback references, because a `const` helper read during render before its declaration ("Cannot access parseTimed before initialization") took every table on the published build into the error boundary and neither tsc nor any unit test saw it.
