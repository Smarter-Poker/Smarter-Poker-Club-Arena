# tests/an-awaited-element-is-never-asserted-instantly.law.test.ts

An awaited element is never asserted instantly: `findBy*` resolves when the element EXISTS, not when it has settled, so a bare `toBeEnabled()`/`toBeDisabled()` on an awaited element passes on an idle laptop and fails on a loaded runner (it cost a run on 2026-09-04 at load 40, while passing 6/6 locally). Wrap it in `waitFor` - same assertion, without demanding the first tick. Synchronous prop-driven assertions are untouched, they have no race
