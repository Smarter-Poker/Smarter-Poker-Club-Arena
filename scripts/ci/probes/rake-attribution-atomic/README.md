# Native rake attribution boundary

`baseline.json` contains the captured production settlement and global-lane
definitions, their owner/ACL/body hashes, and original received alert IDs.
The target definition MD5 is7cf1d81246d015b65d416ee6b3f96838; its body-only MD5
is0e7baa1bfeb2a2d0fed749a52f32d520. These are different hash inputs, not drift.

The existing GitHub-hosted `accounting_postgres` job invokes the driver with its
installed PostgreSQL17 tools. The equivalent package command is:

```sh
PG_BIN=/usr/lib/postgresql/17/bin npm run test:db:rake-attribution-atomic -- --output /absolute/new/evidence/path
```

The runner uses one owned PostgreSQL17 cluster,16MB shared buffers and at most
six connections, with a private Unix socket and no TCP listener. It stops and
removes only its own cluster. No package or dependency installation is used.

The actual target and lane definitions execute against explicit financial
transaction recorders. A real row-lock timeout reproduces banked-but-unattributed
baseline behavior; the candidate must roll back the full call. Real two-session
deadlock/released-lock tests preserve bounded retry behavior. A synthetic
40P01 exhaustion supplements the real one-deadlock retry test; it is not four
independently observed native deadlocks. Complete financial dependency,
Linux/runtime, release and production qualification remain required.
