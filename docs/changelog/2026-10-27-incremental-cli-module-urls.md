# Resolve qualification child imports from their owning test module

The qualification CLI regression embedded TypeScript-relative imports in its child program. Those paths depended on the child working directory and were flagged by the server runtime-import guard. It now passes explicit file URLs resolved from the owning test module, while retaining the actual tsx child loader, server working directory, governor assertion and no-output refusal assertion.

The unchanged source guard reproduced the two offending imports before this correction. Focused validation executes both the guard and the actual CLI child; no held-out plan, deal, runtime strategy or import guard is changed.
