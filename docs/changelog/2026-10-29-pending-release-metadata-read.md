# Read the existing pending release without changing it

The existing Production Integrity Audit release recovery reader previously required a completed seal, so it could not explain an in-progress host transaction whose provider log was unavailable. An explicit `mode: pending_transaction` now reads only the exact durable request and intent, control identity, request and break deadlines, existing certificate-wait marker, fixed systemd unit metadata and bounded same-invocation journal categories. The default sealed-recovery protocol is unchanged. Missing or changing evidence refuses; unmatched or absent retained signs remain unknown. No release operation or application payload is exported.

The existing hash-only predecessor provenance census also includes the ten compiled continuation, controller, accounting and custody modules needed to qualify the EED bootstrap profile. It exports hashes and sizes only. Private image export remains behind its existing private-repository gate.

Native regression fixtures demonstrate the pending request was refused before this extension and the required provenance modules were missing. Maintained fixtures exercise metadata ownership, closed modes, no-follow bounded files, forged exports and exact-unit journal selection. This is diagnostic source support; it does not prove activation, custody transfer or incident recovery.
