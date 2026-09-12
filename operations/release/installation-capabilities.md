# Controller installation capabilities

This is a source audit, not an installation receipt or executable configuration.
No login, credential, authority or workflow identity is supplied here. The actual
fixture runtime and installed ordinary-writer exclusion remain unproven, so this
source must not be treated as activation readiness.

## Source that can be reviewed and packaged

| Source piece                                       | Implemented boundary                                                                                  | Capability still required                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `build-bundle.mjs`, `installed-bundle.mjs`         | Exact file manifest, immutable bundle directory, ownership checks and rendered existing service names | Reviewed existing Linux user/group, locked dependencies, root-owned installed files and bundle receipt                              |
| `native/install-controller.py`                     | Journal-bound native bootstrap/upgrade, service install and fresh process/epoch readback              | Existing root authority, systemd/Node, service directories, configuration, private journal and a positive installed startup receipt |
| `controller.mjs`, `controller-runtime.mjs`         | Actual entrypoint, mode-specific dependency assembly, one owner session and both callbacks            | Complete reviewed configuration, named credentials and exact installed provider binding                                             |
| Private journal and component migrations           | Durable operations, distinct role boundaries, immutable qualification and cleanup receipts            | Reviewed migration execution, existing narrow logins, TLS and verified role membership; no administrator used as a narrow signer    |
| Engine stage and v2 intake sources                 | Exact source/image/run checks and mode-aware native observation                                       | Separate fixed stage helper/config/control-script/unit installation and v2 host boundary receipts                                   |
| Native static reader and original static publisher | Exact existing artifact readback and same-run publication grant                                       | Fixed reader authority with the publisher lock's effective UID/GID, authenticated ingress and proven ordinary-writer exclusion      |
| Semantic adapter/workflow/driver/oracle            | Owned exact before/intermediate/after qualification with cleanup evidence                             | Complete isolated service runtime, sanitized playable schema/actors, pinned image and successful real artifact execution            |
| Maintenance verifier and native operation sources  | Independent proof and on-demand engine maintenance lifecycle                                          | Existing independent verifier account, socket, credentials, host integration and applicable maintenance certificate                 |

## Required configuration relationships

The full runtime-to-journal mapping is in `component-controller.md`. The following
relationships are easy to miss during bootstrap:

- `github.controlSha` and `github.controlRef` must identify the exact reviewed
  control workflow checkout. Certificate v2 currently supports the narrower
  `heads/[A-Za-z0-9_/-]+` branch alphabet. Although qualification adapters accept
  dots, certificate ingress rejects them; dotted control branches cannot be used
  by the combined configuration without a separately reviewed grammar change.
- The source-selected build, frontend, static, certificate and component
  qualification workflow IDs and immutable runtime digests must agree with the
  private installation binding. Their similarly named camel-case runtime and
  snake-case journal fields are not interchangeable JSON keys.
- `components.static_control_receipt_path` supplies the verified closure receipt.
  Its digest must also be installed as `github.static_control_closure.digest`.
  A later source SHA with unchanged reviewed controls is refused by the database
  when that mapping is absent.
- `github.fixtureAuthority` and `github.staticAuthority` need exact HTTPS URL,
  audience and existing installation receipt. They refer to distinct registered
  certificate/static ingress purposes, even though both callbacks share the
  bounded admission socket.
- `components.compatibility.contract` requires `version`, `before_components`,
  `retained_artifacts`, `schema` and `cutover_order`. Schema provenance includes
  original artifact/run/archive and fixture/full-catalogue/engine-contract
  digests. Before artifacts need exact source/identity/run/artifact/archive
  provenance. These are reviewed facts, not examples or inferred placeholders.
- The installed engine-then-web order now serves web-only and mixed releases by
  filtering to changed components. The before tuple and retained artifact map
  seed only the initial baseline. The durable resolver derives later baselines
  from selected completed certificates, exact original artifact ancestry and
  cleanup evidence. An attempt captures its original tuple and only its exact
  successful publication prefix can change the expected live state. Bootstrap
  seed facts must also match `compatibility.bootstrap` in the journal binding.

## Provisioning this bundle does not perform

`installedCredential()` reads only named entries in systemd's
`CREDENTIALS_DIRECTORY`. The shipped controller service has a commented
`LoadCredential` example; bundle rendering substitutes service identities, and
the installer installs that service. Neither provisions the GitHub, webhook,
admission, catalogue or callback credential mappings. The existing service's
reviewed root-owned credential drop-in is an independent requirement.

The admission socket is `0600` under a service state directory of `0700`. An
HTTPS ingress under a different account does not gain access just because the
callback code exists. Its exact access and identity must be installed and proved;
this audit does not broaden socket permissions or grant controller authority.

The stage adapter invokes the fixed helper at
`/usr/local/lib/club-arena-release-controller/engine-stage-boundary.py`. That
helper requires its fixed staging configuration, reviewed control scripts and
stage unit. The controller installer installs the controller service; the v2
engine installer supplies the intake router. Neither installs the complete stage
set. Native static readback likewise checks that its effective UID/GID match the
existing publisher lock. A separate read-only login by itself cannot satisfy that
check; a constrained fixed-reader installation remains to be demonstrated.

## Actual startup evidence and limits

Running the actual Node entrypoint from the integration checkout refuses absent
configuration and refuses checkout-owned configuration before reaching journal
connection. Runtime/HTTP tests prove dependency wiring and narrow callback and
admission TLS/login checks. Those are distinct from a positive root-owned Linux
bundle startup; that requires the existing host, identities and private journal.

The owner connection uses `RELEASE_JOURNAL_DATABASE_URL` and a verified
`direct`/`session` endpoint. Installed configuration must supply
`journal.database_principal` and `journal.database_ca_path`. Controller startup
and native bootstrap/upgrade inspection now require the exact URL login, a
root-owned CA, authenticated TLS and the exact isolated controller membership
before acquiring ownership or reading bootstrap state. SSL URL parameters are
refused so they cannot replace the CA verification settings. Existing operator,
verifier, submitter, callback and administrative authority is refused for that
owner login. No installed identity or positive Linux startup is established by
these local tests.

The shared static publication and production certificate/cleanup concurrency
groups retain `cancel-in-progress: false` and set `queue: max`. This preserves
up to 100 pending jobs instead of replacing older pending work. Overflow remains
a cancellation of that exact new operation, never a successful certificate or
permission to redispatch. GitHub documents this bounded queue in its
[concurrency reference](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
The private journal and native host lock still own their existing fences; this
configuration does not prove installed ordinary-writer exclusion.

Even a successful service start would not prove the full semantic fixture,
ordinary-writer exclusion or served production certification. Those capabilities
must be established by the parent operator's remaining release work.
