# Phase 16: Cashier Directory Readiness

## Problem And Repair

HomePage rendered Cashier before memberships and canonical union ownership
finished loading. With no destination yet, tapping Cashier opened Join A Club;
shortcut 4 also gave false no-membership guidance. The six-second spinner
limit made isLoading unsuitable as a readiness signal. Repeated activation
after a directory failure could also start competing retry reads.

The existing directory loader now owns a separate pending state. Only the
current request may settle it; logout clears it after invalidating old reads.
When no wallet destination is available, both entry points report Loading
Cashier Directory while the read is pending. A failed settled read retains the
existing retry path, and a successful empty read retains Join guidance.
Same-account cached destinations remain usable during authoritative refresh.

## Reproduction And Validation

Baseline: 5800a2b9db366b831e7c01ce2cead1dca80911bb, September 10, 2026.
The actual mounted HomePage, Cashier tile, directory resolver and bus hook
reproduced five failures with three preservation cases passing. No fixture
failures were included. After repair, all eight mounted cases passed.
The suite covers both entry points after spinner expiry, union hydration,
confirmed empty results, pending retries, account changes, logout and cache.
The bus fixture bypasses debounce; this is not live transport acceptance.

Existing Cashier tile, Phase 4 integrity and membership warm-start contracts
also passed: 49 tests across four files, including the eight new cases.
The required npx tsc --noEmit and npm run build both passed.

## Scope And Acceptance

The repair adds no cron, timer, subscription, dependency or database change.
It does not open a wallet menu before wallet rows are available and does not
claim to explain the older production right-click failure. Engine release
sealing, Stage-B DDL and the Diamond programme remain separately owned.

Phase 15 source publication and merged release evidence remain intact.
Its latest production E2E run 34440738779 on 56962e048d024cb3215a255529c7b1491873db72
passed the live database contract and authenticated production Cashier steps.
The deployed-page group and cleanup were still pending when this note was
written. The supported controlled browser again timed out listing tabs;
natural reconnect and physical iPad/PWA acceptance remain unverified.

Phase 16 publication requires fresh public/origin stamps and actual referenced
assets after normal auto-PR, CI, autopilot and publisher completion.
