# Preserve validated V31 matrix constraints during numeric installation

The first installation attempt rolled back after revalidating historical
matrix keys under an exclusive runtime-cell table lock. The uninstalled
migration now retains both validated constraint OIDs and extends their exact
versioned validators only for the new public215 representation: all three
matrices must be SQL NULL, the street must be valid, and compact action specs
must remain valid. All other versions keep their previous function bodies;
owner, ACLs, configuration, strictness and volatility are preserved and checked.

The new representation constraint validates only mutual payload shape and
requires a true result, rejecting UNKNOWN from a missing representation.
There is no deferred constraint, timeout increase or qualification exception.
The isolated native PostgreSQL fixture migrates an existing valid legacy row,
proves zero legacy-validator calls during installation, retains validated
constraint OIDs, and checks legacy invalid writes plus numeric NULL, partial and
missing-representation storage boundaries. Storage probes roll back; source,
model, heldout and certification gates remain separate and unchanged. A sixth
installed readback binds the validator definitions and all three validated
constraints.
