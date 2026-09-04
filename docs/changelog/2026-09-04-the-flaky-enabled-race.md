# The red run that no diff explained

PR #2934 changed `.github/workflows/ci.yml` and a changelog. Its Client Unit
Tests job failed on:

    tests/components/club-data-page-renders.test.tsx
      > ClubDataPage > retires stale game pagination when a sort establishes a new cursor
      Error: expect(element).toBeEnabled()

Nothing in that diff can affect that test. Run locally six times: six passes.
The run had happened while the CI boxes were at load 40, mid-rescale.

## The shape

    const rankedLoadMore = await screen.findByRole('button', { name: '...' });
    expect(rankedLoadMore).toBeEnabled();

`findBy*` resolves the moment the element EXISTS. It promises nothing about the
element having settled. The button is rendered disabled while its fetch is in
flight and enabled on the next update, so the assertion is racing React by a
few milliseconds. On an idle laptop the update always wins. On a loaded runner
it does not.

## Why this one matters more than a slow test

A red run with no explanation in the diff is worse than a slow one. It teaches
every agent that CI is unreliable and that the correct response to red is to
re-run it — which is exactly how a real failure eventually gets waved through.
"CI fails constantly" is partly this.

## The fix, and its limit

Five assertions across three files now use `waitFor`. The assertion is
unchanged — the element must still reach that state — it just no longer demands
it on the first tick.

A repo-wide scan found 19 bare `toBeEnabled`/`toBeDisabled` calls, but only
these five are racy: the other 14 assert a prop-driven state on a
synchronously-rendered element, where there is no race and `waitFor` would add
latency for nothing. The distinction the scan makes is whether the element was
obtained with `await`.

`tests/an-awaited-element-is-never-asserted-instantly.law.test.ts` pins that
distinction so the shape cannot return. It was verified by injecting the racy
shape into an unrelated test: the law failed, named the exact file and line,
and went green again when the injection was removed.
