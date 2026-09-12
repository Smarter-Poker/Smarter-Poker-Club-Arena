# Native fixture smoke

`component-fixture-native-smoke.yml` runs for affected draft or ready pull requests from the same repository. The required TypeScript gate accepts a native skip only after exact Git classification positively establishes that the fixture is unaffected. It checks out the exact PR head, uses read-only repository access, disables persisted checkout credentials, and runs on hosted Linux amd64. It has no dispatch, production environment, credential input, registry login, image push, or release callback. The artifact is native service smoke evidence, never a product compatibility certificate.

The workflow requires the reviewed fixture package committed alongside it. Do not copy partially reviewed staging files to make the job pass. The build script must use its committed allowlist context and stamp these labels with checked-out HEAD:

- `org.opencontainers.image.revision`
- `com.smarter-poker.control-revision`
- `com.smarter-poker.source-revision`

Source must be `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena` and scope `isolated-component-fixture`. The runner verifies the labels, Linux amd64 platform, local image ID, tracked nonsymlink source and source hashes. The build script owns verification of the exact Docker context. All fixture files must be clean against HEAD.

The smoke script must honor `FIXTURE_SMOKE_CONTAINER`, matching exactly `^ca-fixture-smoke-[a-f0-9]{32}$`. It uses that name plus `-peer`, `-preimage` and `-network` for its owned resources. It emits exactly one native-service observation, one observer/Chromium observation, one peer observation and one service-preimage proof, followed by the explicit successful cleanup line. The runner requires all of them and independently verifies the three containers, network and image are absent. A timeout or leftover resource remains failure even when emergency cleanup succeeds. Only the invocation's exact resources and unique image tag are removed; there is no global prune. Local images are never uploaded. Base layers/build cache remain disposable hosted-runner resources.

The fresh `fixture-server preimage` container runs the real fixture bootstrap through its exact Auth/Realtime ledgers, without an application archive or actors. The owner copies its read-only catalog while the container is alive, acknowledges the copy and then requires normal shutdown. The runner requires `FIXTURE_SERVICE_PREIMAGE_PATH` to be outside uploaded evidence, validates bounded nonsymlink regular-file bytes against the unique proof and exact allowlisted metadata shape, and only then exposes `native-service-preimage.json`. The private candidate is removed on success and failure. Its role/settings/default-ACL/schema/extension metadata is local disposable-fixture evidence; it does not establish production binary or application privilege parity.

The receipt includes source file hashes, exact revisions/image ID, fixed allowlisted service observations and cleanup booleans. A native failure may include an enumerated stage and error category; messages, stacks, query text, session data, credentials and environment are never copied from runtime output. The separate bounded `native-build.log` contains only the reviewed image build, before any runtime credentials or users exist. Abrupt runner termination can prevent receipt creation; missing evidence is not success.

Local contract tests use simulated Docker responses. They verify wrong revision/labels, symlink input, missing or duplicate observations, timeout cleanup, catalog provenance and sanitization. They do not establish that the Linux image builds or services run.

[Native Linux run 34660221728](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34660221728) passed at `ef6ab8d71b60fe67af5fc978148b9bacb64f9686`. Its receipt proves PostgreSQL/extensions, GoTrue/MFA, PostgREST/RLS, authenticated Realtime change delivery, distinct observer UID, Chromium and peer isolation with zero retries. All four container/peer/network/image cleanup fields are true. The image was not published. The full application schema and actual engine/web tuple oracle remain required for product qualification; native smoke explicitly reports `product_certificate: false`.

Dependency installation and image builds belong in CI. Do not install or copy full `node_modules` trees into Mac agent worktrees. An existing shared installation may be reused for local source checks without modifying its packages.
