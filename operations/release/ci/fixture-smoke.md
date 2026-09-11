# Draft native fixture smoke

`component-fixture-native-smoke.yml` runs only for a draft pull request from the same repository. It checks out the exact PR head, uses read-only repository access, disables persisted checkout credentials, and runs on hosted Linux amd64. It has no dispatch, production environment, credential input, registry login, image push, or release callback. The artifact is native service smoke evidence, never a product compatibility certificate.

The workflow is intentionally not runnable until the reviewed fixture package is committed alongside it. Do not copy partially reviewed staging files to make the job pass. The build script must use its committed allowlist context and stamp these labels with checked-out HEAD:

- `org.opencontainers.image.revision`
- `com.smarter-poker.control-revision`
- `com.smarter-poker.source-revision`

Source must be `https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena` and scope `isolated-component-fixture`. The runner verifies the labels, Linux amd64 platform, local image ID, tracked nonsymlink source and source hashes. The build script owns verification of the exact Docker context. All fixture files must be clean against HEAD.

The smoke script must honor `FIXTURE_SMOKE_CONTAINER`, matching exactly `^ca-fixture-smoke-[a-f0-9]{32}$`. It must use that name for creation and its cleanup trap. It must emit exactly one native-service observation and one observer/Chromium observation in the existing JSON format, then the explicit successful cleanup line. The runner requires all three and independently verifies container absence. A timeout or leftover container remains failure even when emergency cleanup succeeds. Only that exact invocation's container and unique image tag are removed; there is no global prune. Local images are never uploaded. Base layers/build cache remain disposable hosted-runner resources.

The receipt includes source file hashes, exact revisions/image ID, fixed allowlisted service observations and cleanup booleans. A native failure may include an enumerated stage and error category; messages, stacks, query text, session data, credentials and environment are never copied from runtime output. The separate bounded `native-build.log` contains only the reviewed image build, before any runtime credentials or users exist. Abrupt runner termination can prevent receipt creation; missing evidence is not success.

Local contract tests use simulated Docker responses. They verify wrong revision/labels, symlink input, missing or duplicate observations, timeout cleanup and sanitization. They do not establish that the Linux image builds or services run. A real successful Linux run must still prove PostgreSQL/extensions, GoTrue/MFA, PostgREST/RLS, Realtime change delivery, distinct observer UID and Chromium, with complete cleanup. The full application schema and actual engine/web tuple oracle are separately required for product qualification.
