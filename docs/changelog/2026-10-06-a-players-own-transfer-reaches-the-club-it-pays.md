# A player's own transfer reaches the club it pays (2026-10-06)

## What was wrong

No member holding chips could leave any club. Found while proving the
club-leave fixes against production, in one rolled-back probe run as the
member:

| member             | chips     | leave                                      |
| ------------------ | --------- | ------------------------------------------ |
| Deep Stack Society | 0.00      | succeeds                                   |
| Deep Stack Society | 10,038.65 | 23514 accounting_invoice_recipient_missing |
| ordinary club      | 5,000.00  | 23514 accounting_invoice_recipient_missing |
| ordinary club      | 0.00      | succeeds                                   |

The whole leave rolls back, so no chips moved, and the client says "Failed to
leave club - please try again".

Leaving moves the member's wallet to the club treasury. That transfer's
invoice is addressed by `fn_deliver_accounting_invoice`, which looked both
parties up through `fn_accounting_party_users`. That function is callable from
a browser and so answers only to the engine or to someone who is a member of
the party asked about. The leaving player is the issuer and is never one of
the club's officers; the recipient side came back empty and delivery refused a
transfer with two valid parties.

## The fix, at the cause

Migration `20261006044028`: delivery resolves the parties of record through
its own resolver, `fn_accounting_invoice_party_users`: the same people by the
same rule, with no question about who is asking, executable by no browser
role. `fn_deliver_accounting_invoice` is rewritten from its installed
definition with those two lookups re-pointed and nothing else touched.
`fn_accounting_party_users` is unchanged, so what a browser may see is exactly
what it was.

## Proof

Scratch PostgreSQL 16 with a delivery function of the same shape: before, a
player-issued transfer to a club raises `accounting_invoice_recipient_missing`;
after, the issuer and the club's owner and admin are both resolved, and
`authenticated` is denied the resolver. The production read-back after install
is recorded in the pull request.
