# tests/layer-collapse-reads-its-own-denominator.law.test.ts

`fn_audit_layer_drift` measures a `layer_fire_collapse` against the population the layer can fire on (its variant, cash or tournament decisions, bounty or spin tables), never fleet-wide decides; population counters are not judged as layers; and a layer whose own population fell at least as far is not reported. Dividing by fleet decides turned the 2026-09-27 table-mix swing into 113 false warns and hid a real V15 decay.
