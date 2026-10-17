# Auth initialization acquisition recovery

This is the unchanged MIT-licensed `@supabase/auth-js` 2.90.1 package except
for the three implementations and two private field declarations shown in `initialization-recovery.patch`:
TypeScript source, CommonJS runtime and ES-module runtime. Its package version,
public API declarations, native exclusive lock, lock budget and refresh behavior stay intact.
The original license remains inside the archive.

Production admission showed an initial native lock request abort before its
callback entered. The SDK permanently cached that rejected initializer, so
every later session request rejected without requesting another native lock.
Only that pre-acquisition AbortError/acquisition-timeout generation is retired.
The first caller still receives the original error. A later explicit SDK API
request initializes through the same single-flight native lock. No retry loop
or callback replay is added. Errors after the initializer callback begins and
unrelated pre-acquisition errors remain terminal. Bootstrap fire-and-forget
promises report sanitized error names without emitting fake auth events.

The root dependency and npm override bind every consumer to this archive.
`package-lock.json` pins its integrity, so ordinary `npm ci --ignore-scripts`
installs the repair without an install hook or a runtime prototype patch.

Reproduce from the immutable public-registry tarball:

```sh
python3 scripts/ci/build-auth-initialization-recovery.py --check
```

The generator verifies the original registry integrity before checking each
preimage. `--upstream /external/path/auth-js-2.90.1.upstream.tgz` uses an already
downloaded copy and verifies the same identity. Generation is deterministic;
all other package entry bytes and archive metadata are retained.

Focused CommonJS/ES-module qualification lives in
`tests/unit/authInitializationRecovery.test.ts`. The explicit local native
WebKit check uses no production data or identity:

```sh
PLAYWRIGHT_BROWSERS_PATH=/external/owned/browser-cache node scripts/dev/verify-auth-initialization-webkit.mjs
```

The local browser fixture deliberately refuses one short lock acquisition while
another page owns it, releases that owner, then checks actual SDK requests and
storage reads under the unchanged native lock. Its short fixture timeout is
never production configuration.

Pending same-positive-budget calls now share one native acquisition per SDK
instance. Their callbacks remain separate and run FIFO only after native
ownership begins. Admission failures reject the entire unentered cohort with
the original error; no callback is replayed. Entered work drains before native
release even if the first operation fails. Immediate probes and different
budgets retain independent native requests. Pending admission slots are kept
separate from the already-owned execution queue.

The same focused CJS/ES-module tests cover deferred admission, per-caller
results, rejection, FIFO draining and independent budgets. The native WebKit
fixture additionally holds the lock from another tab, submits sixteen real
session requests and verifies one native waiter, sixteen separately owned
reads and no remaining held/pending locks.
