# Isolate private importer networking from the CI host

Native run34780644162 passed the actual import and all three intended identity, runtime-byte and external-cancellation refusals. All four measured peaks stayed below472MiB with zero OOM increments and complete owned cleanup. The later host builder then failed because its docker0 interface no longer existed. The importer had private sockets and storage but still shared the host network namespace, so its independent Docker networking lifecycle was not isolated from the host bridge.

The owned systemd unit now requests PrivateNetwork=yes. Before starting its daemons and on later resource observations, the worker reads actual network namespace identities, requires a namespace different from host PID1, and requires every observed private process to share that owned namespace. Fault receipts must carry those observations. Configuration alone cannot supply the proof.

The parent also reads the host default bridge network ID, interface name/index and network namespace before and after the complete matrix. A removed or recreated interface cannot count as unchanged. The observation is retained even when the matrix or final read fails. No host network repair, restart, production importer activation, or resource-limit increase is included.

Systemd255 documents the separate loopback-only network namespace, unavailable host netlink and implied private mount namespace: https://github.com/systemd/systemd/blob/v255/man/systemd.exec.xml . Fresh Linux execution is still required to verify the complete source candidate.

Validation:51 importer checks and81 related producer, bundle, qualification, archive and resource checks passed, zero skips. Tests execute the namespace and host-identity parsers with controlled observations, refuse shared/escaped namespaces, and retain failures when host bridge identity changes or disappears. The old generated unit fails the new private-network assertion. Portable tests do not establish native namespace isolation.
