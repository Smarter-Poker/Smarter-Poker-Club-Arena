# Leaderboard Schema Export Accepts The Actual Provider Replica Identifier

The supported pooler inventory returned a primary-bound read replica identifier
with a region and provider suffix, rather than a separate twenty-letter project
reference. The descriptor validator rejected that real endpoint before execution.

Accept the supported primary-bound identifier shape while preserving exact pooler
user agreement, dedicated endpoint validation, TLS, immutable recovery admission,
feedback-off enforcement, PostgreSQL version equality, WAL replay fence, and full
primary catalogue parity. The real descriptor and malformed/foreign identifiers
are covered by focused regression checks. The extracted preflight scenario uses
the same supported metadata shape.

This is qualification tooling only. Source tests and protected integration do not
certify actual Auth or financial behavior. Actual isolated qualification and the
subsequent financial migration and coupled client delivery remain separate gates.
