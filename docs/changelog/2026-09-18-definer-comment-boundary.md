# Definer gate respects SQL quotation and comment boundaries

The MTT branch's required authorization check falsely reported six anonymous
function exposures. Its regular-expression comment remover interpreted an
unfinished `/*` inside a dollar-quoted JSON replacement payload as a SQL comment,
then consumed later migrations through an unrelated comment terminator. That
removed their actual privilege revocations from the checker's input.

The checker now scans SQL quotation and nested comment boundaries. Literal
payloads remain intact; executable function and `DO` bodies still have their
real comments removed, so a comment mentioning `auth.uid()` cannot authorize a
function. Quoted example revocations cannot close access. Dynamic write strings
and grants remain conservatively visible. No function allowlist, migration,
installed privilege, or native database qualification input changed.

Validation on the composed MTT candidate reproduced all six findings with the
previous checker and zero with the repaired checker. The directly invoked branch
gate passed for 41 definers across 19 migrations. The existing definer test suite
passed 55 tests, including the actual migration payload, quoted fake revocations,
real reopened grants, nested comments, executable `DO` blocks, and dynamic SQL.
The same gate and test suite remain in the existing required verification path.
This records local validation; protected checks and delivery are tracked by the
owning MTT release.
