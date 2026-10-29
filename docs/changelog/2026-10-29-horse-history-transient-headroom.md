# Retained public-history representation admission

The shared encoded-byte ceiling did not check current isolate headroom when an
already-retained original was cloned, reparsed after a worker's null ACK, or
serialized after a valid ACK. The finite native isolation confirmed this missing
admission path; it did not reproduce or attribute the production V8 exhaustion.

Check the actual retained claim's encoded bytes with the existing representation
allowance and transient reserve immediately before each allocation. Refusal
preserves the exact original, digest, cutoff and client-specific ACK. A valid ACK
can retain its decoded original when serialization is refused. A refused read
returns unavailable with the existing closed invalid-claim, heap-unavailable or
heap-headroom reason from that same admission call,
bound to the actual observer and exact attempted decision cutoff. State and
provenance do not take a second heap sample; a later admitted read restores the
original window without another load. No cap, heap limit, timer or retry changes.

Regression cases cover clone, parse and ACK allocation refusal, intact claims,
null-ACK recovery, cutoff exclusion, actual worker acceptance of a matching
refusal and rejection of a forged cutoff, and a later admitted original packet.
This closes the demonstrated admission coverage gap. It does not establish a
hard bound on V8 object expansion or identify the production fatal's allocator.
