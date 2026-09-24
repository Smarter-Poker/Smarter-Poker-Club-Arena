# tests/one-capability-registry.law.test.ts

`public.platform_capabilities` is the one technical capability registry and `src/config/platformCapabilities.ts` only mirrors it: the migration's seed ids must equal the TypeScript ids, the readiness ladder and scope vocabulary must equal the database CHECKs, `variant.ofc` stays seeded `excluded` (owner decision: no OFC), and the client offers a capability only when the RPC says available AND its readiness is `deployed` or `production_verified`, never from a hardcoded flag. A failed read is `unknown`, never an empty registry.
