# tests/engine-release-seal.law.test.ts

The engine may start only an immutable release authorized by the durable host seal. A candidate remains non-persistent until its HTTP, proxy, and database proofs commit that seal; recovery and rollback always converge on the exact sealed desired image.
