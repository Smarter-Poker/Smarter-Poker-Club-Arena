# Tournament entry fees retain their cents

The shared entry-price formatter rounded a stored fractional fee to a whole chip. A 1-chip MTT entry funded as 0.90 + 0.10 appeared as `1 (1 + 0)`, and a 15-chip entry appeared as `15 (13 + 2)`. This misrepresented the house fee before registration.

`formatBuyIn` now uses the existing exact-component formatter for the fee and remainder. The advertised total remains whole chips. The lobby, signup dialog, tournament details and tournament pages already call this helper, so they receive the correction together. This changes display only.

Seven regression cases cover 0.10, 0.50 and 1.50 fees, a 0.05 heads-up fee, a whole-chip fee, zero-fee Spin and Free Buy.

Phase 3 T02 calculation evidence: the installed immutable `fn_tournament_entry_split` body (MD5 `46074e04b60ecb97557b63ef25c5739d`) passed 161 read-only cases at 2026-09-09 22:52:57 UTC. These covered all 22 generator price points plus zero, across MTT, SNG, heads-up, Spin and the 30/40/50 percent bounty templates. Every case conserved total = prize + bounty + fee without a negative component. No tournament entries or financial rows were created. This checks the calculator and listed templates, not full admission, promotional bank funding or every custom configuration.

Phase 3 remains incomplete. PR #4039 still requires the separately blocked historical-restoration approval. The production table-move dependency and remaining lifecycle controls are also open. Phase 4 has not started.
