# 2026-09-05 - main carried `parseTimed` twice; the publisher refused it

The P0 table crash fix (`parseTimed` to module scope) was landed two ways so
neither could block the other: as a minimal hotfix (#3104) and inside the
Phase 1 pull request (#3095). Both merged within minutes. Each PR's own
TypeScript Check ran against a `main` that had only one copy, so both were
green; the squash of the second onto the first left `MultiTablePage.tsx` with
two `parseTimed` implementations, and `npm run build` (`tsc -b`) in
`publish-club-arena.yml` stopped the publish. Production stayed on the
hotfix squash (`a505dca7f`), so players were never exposed - the failure was
a red `main` and a phase that did not ship.

This PR removes the duplicate. Lesson, recorded: when the same hunk rides two
PRs, merge `main` into the second AFTER the first lands, or drop the hunk from
one of them. The required checks test each PR against the `main` of its
moment, not against each other.
