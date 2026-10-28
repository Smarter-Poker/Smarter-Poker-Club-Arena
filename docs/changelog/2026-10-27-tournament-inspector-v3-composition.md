# Compose tournament predicate and postflop inspection

The ordinary merge of 361ec63a64da67fd35e76522bfef5fa99aebe72e into the tournament predicate branch retains its original tournament CLI/helpers and mutually exclusive workflow mode while adding the exact v3 postflop selector. The one conflict was the child module invocation: it now includes the optional installed deterministic Omaha evaluator and keeps the awaited stdout flush.

Three Python function pins and the embedded JavaScript pin bind the reviewed composed bytes. Those functions and JavaScript are byte-identical to the reviewed v3 source. Original tournament-only helpers are byte-identical to the predicate parent. V1/v2 source/hand/decision/receipt/execution/reconciliation checks remain; v3 additionally binds actor, seat and street and exports only the closed scalar summary. No raw records, replay verification or activation permission is added. Cash CI bindings and runtime strategy are unchanged.

Validation: focused predicate wiring, complete inspector and horse CI source checks, root/server TypeScript compilation and normal commit hooks. Provider checks and live inspection remain separate.
