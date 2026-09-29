# tests/a-workflow-step-fits-what-github-will-run.law.test.ts

Measures every `run` step in `.github/workflows/` against GitHub's documented
21,000 character ceiling, and reports one past 90% of it before the ceiling is
reached. Over the limit GitHub stops loading the whole workflow rather than
failing the step: on 2026-09-22 the Club Arena publisher went nameless, created
zero-job runs for branches its triggers exclude, answered a repository_dispatch
with no run at all, and nothing reached production for over an hour.
