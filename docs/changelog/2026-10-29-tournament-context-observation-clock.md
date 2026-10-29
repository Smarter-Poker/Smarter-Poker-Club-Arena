# Tournament context belongs before the request cutoff

The live scheduler previously stamped its policy cutoff before assembling the tournament cache read. A clock tick during synchronous assembly could make a complete, correctly bound context appear newer than its own request and be refused by Phase14 provenance validation.

The request now records its observation cutoff after its inputs are assembled. The original turn-start clock still measures elapsed think time; worker deadlines and protected-clock closures are unchanged. Actual HandController/cache regression fixtures cover a fixed clock, an advancing clock, retained provenance refusals and visible delay accounting.

This reproduces a source defect. It does not establish the precise cause of any retained historical gap, qualify a strategy, or prove runtime installation or all-horse coverage.
