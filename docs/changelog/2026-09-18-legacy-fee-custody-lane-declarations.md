# Reviewed legacy custody children retain their existing settlement lane

The live lane-doctrine check reported two undeclared callers after installation
of the qualified historical fee-custody authority: `fn_ca_hold_legacy_tournament_fee`
and `fn_ca_begin_legacy_fee_resolution`. Each is postgres-only. The former is
called by the existing terminal body after player settlement; the latter is
called by the existing rake owner before canonical attribution. Both parents
already take the reviewed settlement lane. Re-entry preserves an existing finish
lane through the current global helper; this adds no new lock or caller.

An additive migration pins the two reviewed financial definitions and their
private access, then adds only their names to the doctrine's reviewed list.
The four rules, traversal, function access and financial bodies remain unchanged.
Unknown global callers still fail, as does any rolling path reaching either newly
declared child. The live checker is unchanged and still reports the actual
installed catalog; its declaration check can pass only after installation.

The existing Sep8 native phase reproduces the exact two missing declarations,
checks the reader's precise before/after definition, preserves all other catalog
findings, rejects altered reviewed authority at installation, and exercises all
four negative rules including rolling paths into both children. The existing
five financial continuations still run with their original invariants.
