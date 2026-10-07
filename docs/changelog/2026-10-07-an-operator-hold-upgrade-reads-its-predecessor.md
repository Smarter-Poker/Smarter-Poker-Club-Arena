# An operator-hold upgrade reads its predecessor

Public engine identity and the sealed image receipt do not expose the compiled bytes or Node runtime needed to qualify the first durable operator-hold handoff. The existing production-integrity audit now accepts an explicit exact release/image observation. A fixed read selects container/process identity, immutable image label, actual Node binary version and fourteen compiled-file hashes. It refuses mismatched, incomplete or changed identity. It never imports application modules, reads environment values, opens an inspector, changes pauses or starts a release. Scheduled audits do not open this transport.

This supplies evidence to the existing owning engine transaction. Handoff and rollback still require their connected qualification before activation.
