# A red E2E run names its failed test (2026-10-04)

`Post-Deploy E2E (production)` failed three runs in a row on 2026-10-04 at "Certify the authenticated production Cashier" and "Run the specs that need a deployed page". Through the check-run API the only evidence was "Process completed with exit code 1". The failing test and its Playwright error were only in the job log and the uploaded report, both served from blob storage that a session reading the API cannot always reach.

`scripts/ci/annotate-e2e-failures.mjs` reads the JSON reports the job already writes and prints one `::error` per failed or timed-out test (file, line, title, first 700 characters of the error). GitHub keeps them as check-run annotations, readable with `gh api <check_run_url>/annotations`. The first nine failures are named; the tenth annotation counts the rest and names any missing report. It only reports and always exits 0; the steps that ran the specs still own the verdict.

Wired into the `Client browser verification` job of `post-deploy-e2e.yml`, before "Did the suite actually verify production?".
