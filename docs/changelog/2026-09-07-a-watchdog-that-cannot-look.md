# A watchdog that cannot look must not say the coast is clear

**2026-09-07** — branch `fix/a-watchdog-that-cannot-look-must-not-close-the-alarm`

`check-main-is-green.mjs` is the estate's detector for a workflow that is red on
`main` with nobody watching. It exited **0** on every answer it could not read —
no token, an API error, an empty run list — with the reasoning written beside it:

```js
console.log('No GITHUB_TOKEN; skipping (a watchdog that cannot ask is not a failure).');
process.exit(0);
```

That reasoning is sound about **paging** and wrong about everything else,
because exit 0 is not silence here. Its own workflow reads it:

```yaml
- name: Close it when main is green again
  if: always() && steps.main-green.outputs.code == '0'
```

**So one HTTP 502 from `/actions/runs` closes a standing issue about a workflow
that is still red**, with the comment "Every workflow's latest run on main is
green again." The alarm that 10.83 was written to build would have switched
itself off on a network hiccup.

## The fix

Exit **3** for COULD NOT TELL — never 0, never 1 — at all three points that
used to fold an unreadable answer into green: a missing token, a failed run
listing, an empty run listing. The workflow prints a warning annotation on 3
and touches no issue in either direction.

This is 10.86 rule 1 applied to the file 10.86 was written next to. It is also
rule 4: the estate had already learned this lesson twice (`pr-status.mjs` exits
3 for UNKNOWN, `check-ddl-reload-storms.mjs` exits 2), and the detector everyone
else's red run reports to had not been given the same treatment.

## What is pinned

`tests/a-watchdog-that-cannot-look.test.ts`, six cases:

- running the checker with no token in the environment really does exit 3, and
  says `COULD NOT TELL` in words rather than only in a code;
- at least three `process.exit(UNKNOWN)` sites exist, and the old sentence that
  taught the next reader this was fine is gone;
- exactly **two** `process.exit(0)` remain — the two genuinely green reads — so
  a fourth one appearing is a test failure rather than a quiet regression;
- the workflow closes on an exact `'0'` and raises on an exact `'1'`, and never
  on a truthiness or a `!= '1'` test, either of which would let 3 through.

## Files

- `scripts/ci/check-main-is-green.mjs`
- `.github/workflows/publish-watchdog.yml`
- `tests/a-watchdog-that-cannot-look.test.ts` (new, 6 cases)
