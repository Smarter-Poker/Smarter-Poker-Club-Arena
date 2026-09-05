# tests/one-build-three-suites.law.test.ts

The CSS Beat E2E job builds the app ONCE, with the two test-harness flags, and
every suite in it shares that one preview - because the Table Studio suite used
to start a Vite dev server and compile the app a second time, which measured
141-200s on runs 8843/8844, roughly half of the job that is the critical path
of every Club Arena merge. The safety of that trade reduces to one property
this law holds: `VITE_CUSTOMIZATION_TEST_HARNESS` and
`VITE_FINANCIAL_DECISION_TEST_HARNESS` appear in the css-beats-e2e job and
NOWHERE else - never in `Production Build`, never in
`publish-club-arena.yml` - so the harness routes cannot reach a bundle a player
downloads. It also pins that the preview is started in its own step rather than
inside the beats (a `trap ... EXIT` there is what killed it early and forced
the second compile), that it is reaped on `always()` since `--strictPort` makes
an orphan poison every later job on the runner, and that both Playwright
configs keep their `webServer` fallback so the suites still run locally with no
shared preview.
