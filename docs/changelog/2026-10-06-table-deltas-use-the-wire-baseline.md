# Table deltas use the wire baseline

An isolated funded gameplay check exposed an invalid JSON Patch from the table
state producer. The first snapshot omitted undefined optional fields during JSON
serialization, while the hub retained those fields with structuredClone. A later
defined value therefore emitted replace for a path the client had never received.
Removing an already omitted field also emitted an invalid remove.

TableStateHub now normalizes each public snapshot to its JSON representation once
before comparing or retaining it. Live deltas, late joins and resyncs share that
same independent baseline. Per-room serialization, sequence-gap protection,
backpressure and private-event routing remain intact.

The connected producer/strict-consumer regressions fail before this change and
pass afterward, covering optional nested fields, omission, array null semantics,
producer mutation and reconnect snapshots. This is an engine transport change;
source qualification is distinct from protected activation and live proof.
