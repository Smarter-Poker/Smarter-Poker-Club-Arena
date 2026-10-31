# URL pushes retain their destination main baseline

Git passes the literal URL as the first pre-push argument when a push names an HTTPS destination. The hook treated it as a remote name, failed to find `<URL>/main`, and used stale local `main`. A one-migration branch consequently scanned 228 migrations already inherited from protected main.

The hook now associates its actual destination with configured tracking remotes that agree on one main commit and captures that main commit once for changed-file, inherited-main and migration selection. SSH/HTTPS forms and the maintained Club Arena transfer aliases identify the same repository; forks, mixed fetch/push repositories, divergent main tips and missing tracking refs never substitute local main. Unknown association refuses with a diagnostic. Actual destination verification, fetches, non-fast-forward protection and migration checks remain active.

Real isolated Git fixtures cover named and URL pushes, transfer aliases, forks, URL rewrites, ambiguity, unavailable tracking refs and feature tips, stable capture, and the old two-migration versus corrected one-migration selection. This changes workstation submission tooling only; it requires no production engine replacement or database installation.
