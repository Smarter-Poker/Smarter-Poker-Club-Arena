# Union ECO terms retain their original settings write

The Union P&L diagnostic always reported missing ECO commercial basis, while the
agreement journal captured only agents, members and Union club rates. Union ECO
settings could change without immutable earning-time evidence.

The successor migration extends the same journal with Union scope. Its trigger
captures only ECO settings at their actual insert, change or deletion, including
the actor and before/after values in the same transaction. It does not baseline
current settings, backdate observations or supply missing defaults. Existing
agreement immutability, private access and club-scope requirements remain.

The existing private P&L report now evaluates exact, half-open term coverage.
Explicit types, supported formula modes, finite percentage rates and inclusion
of horses are required. Missing coverage, ambiguous observations, discontinued
settings and invalid terms remain blocked. The original formulas are unchanged;
the result describes commercial evidence and does not calculate an ECO payment.
The other five P&L gaps, `basis_certified:false` and payment refusal remain. The
report also no longer claims every player was included without population proof.

The existing PostgreSQL agreement-history CI step exercises the actual settings
trigger, journal, private reader and P&L report together, alongside the unchanged
agreement regressions. It covers exact boundaries, changed rates, rollback,
duplicates, deletion, identity changes, malformed/unsupported policies and API
privilege refusal. Historical periods before original capture remain unresolved.

Delivery requires qualification and installation of this successor after Union37,
fresh source/ACL/catalog readback and the normal protected checks. Existing Union37
migrations and generated artifacts must not be replayed or rewritten. This change
does not alone establish full-week source population, opening balances, player
ownership, tournament equity or a certified automatic Union close.
