# Fixed current-serving kernel role when release records have retired

The existing pending-release reader refuses before inspecting the socket when its original request records have retired. The observed a2 read returned `pending_request_read/records_absent`; it supplied no current port or process-role evidence. Retired requests and checkpoint intents must never be reconstructed or retargeted.

This finite extension keeps the existing explicit audit event and reader. Its closed `current_serving_inspector_role` request requires the exact legacy EED source and expected public process instance. It reads only the fixed current container and Linux metadata for port 9229. No caller can select a host, path, PID, other port, command or deadline.

The reader binds private host boot identity, container/image/start/restart/main-process identity, healthy local full source/instance and immutable image revision before and after the bounded read. It reuses the existing kernel projection and its two stable snapshots, 256-member cap, 16,384 total descriptor budget and existing per-file limits inside one eight-second deadline. Transport remains 30 seconds and 4 KiB. Private identities, paths and native error text are not exported.

The only socket conclusion is `main`, `other_container_process` or `unknown`. Unknown remains unknown. This mode does not connect to port 9229, launch a container child, use the Inspector protocol, read release files, attach, evaluate, signal, close a listener, change gameplay or start a release. A process role supplies no original inspector ownership, provenance or action authority.

Existing pending, sealed-result and original-intent inspector modes retain their contracts. Native Linux projection cases remain enforced by the connected required law; focused tests cover the new exact selector and mandatory binding/refusal boundaries. Production use requires protected source and the sole provider's explicit current-identity-bound read. This diagnostic is not a gate on the already assigned release. If a qualified current owning operation becomes available first, use its existing scoped route and stop unnecessary extension work.
