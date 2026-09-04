# tests/the-build-typechecks-where-it-ships.law.test.ts

The build typechecks where it ships: `build` is `tsc -b && npm run build:ci` so the two cannot drift, ci.yml's two throwaway builds run `build:ci` while publish-club-arena.yml runs the full `npm run build`, `TypeScript Check` stays ungated by the `changes` filter, and the tsconfigs stay `noEmit` with no `composite`/`references`/dts plugin - which is the whole reason dropping `tsc -b` changes no byte of the bundle
