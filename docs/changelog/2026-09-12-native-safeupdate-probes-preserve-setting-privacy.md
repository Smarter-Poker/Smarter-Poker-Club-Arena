# Native safeupdate probes preserve setting privacy

The first required native run failed because its ordinary authenticator identity probe tried to read PostgreSQL's protected preload-list setting. The HTTP invoker probe contained the same invalid read. The fixture image built successfully and all four resource cleanup checks passed, but no native service result was accepted.

The probes now verify the ordinary-visible registered safeupdate setting and real unsafe-write refusals. They explicitly require protected reads to fail for authenticator, authenticated and the real HTTP invoker path. No role is elevated, no monitoring grant is added, and the library pins and write/rollback/cleanup assertions remain.
