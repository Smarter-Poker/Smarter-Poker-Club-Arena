# server/src/engine/lightningRebuyExpiry.law.test.ts

A Lightning zero-chip occupancy expires after twenty active seconds without a rebuy; dialog heartbeats cannot extend it, and parked anchors deliver paid chips before checking expiry.
