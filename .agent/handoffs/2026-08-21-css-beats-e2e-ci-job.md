# Handoff: land the CSS-beat E2E job in ci.yml (workflow scope required)

**Date:** 2026-08-21
**Blocked by:** the Cowork session's PAT has `repo` but not `workflow` scope, and
GitHub refuses any push that touches `.github/workflows/*` without it. Everything
else from this session is already on main; ONLY the ci.yml job below is parked.

**Why this job exists:** two silent clobbers happened in one evening of
concurrent agent pushes. `tests/e2e/multi-table.spec.ts` and
`tests/e2e/live-animations.spec.ts` are the regression net for the whole
multi-table + gameplay-animation surface, and both were parametrized (already
on main) to run against **the pushed commit's own build** via `ARENA_BASE_URL`.
The recipe below was executed verbatim in the sandbox before this handoff:
**18/18 passed.**

**What to do (any actor with `workflow` scope, e.g. Antigravity on the Mac):**
insert this job into `.github/workflows/ci.yml`, directly above the
`auto-revert:` job, then push via the normal pipeline. Nothing else changes.

```yaml
# ───────────────────────────────────────────────────────────────────────────
# CSS BEAT E2E (2026-08-21): the multi-table and gameplay-animation beats,
# in real Chrome, against THIS COMMIT'S OWN BUILD (served locally under the
# production /hub/club-arena prefix). Two silent clobbers happened in one
# evening of concurrent agent pushes; this is the net that turns the next
# one red before it ships.
# ───────────────────────────────────────────────────────────────────────────
css-beats-e2e:
  name: CSS Beat E2E (multi-table + animations)
  runs-on: ubuntu-latest
  timeout-minutes: 20

  steps:
    - name: Checkout
      uses: actions/checkout@v4.3.1

    - name: Setup Node 20
      uses: actions/setup-node@v4.1.0
      with:
        node-version: 20
        cache: npm

    - name: Install Dependencies
      run: npm ci --ignore-scripts

    - name: Install Chromium
      run: npx playwright install chromium --with-deps

    - name: Build this commit
      run: npm run build

    - name: Serve the build under its production prefix
      run: |
        mkdir -p _srv/hub
        ln -s "$PWD/dist" _srv/hub/club-arena
        (cd _srv && python3 -m http.server 4173 --bind 127.0.0.1 &> /dev/null &)
        for i in $(seq 1 20); do
          curl -sf http://127.0.0.1:4173/hub/club-arena/index.html > /dev/null && break
          sleep 0.5
        done

    - name: Run the beats against this commit's CSS
      env:
        ARENA_BASE_URL: http://127.0.0.1:4173/hub/club-arena
      run: npx playwright test tests/e2e/multi-table.spec.ts tests/e2e/live-animations.spec.ts --reporter=line --retries=1
```

**Verification after landing:** the next push to main shows a green
"CSS Beat E2E (multi-table + animations)" check. If it is red, a real beat
broke - read the failing assertion, it names the exact animation and duration.
