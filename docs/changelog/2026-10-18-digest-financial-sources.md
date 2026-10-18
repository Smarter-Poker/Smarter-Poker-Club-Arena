# Digest rake and escrow attribution corrections

The October 17 rake ledger and per-hand records agree. The58.21 rollup gap is
7,346 Lightning attribution rows with no club: fn_cash_earning_club looked for
physical seats at the synthetic host, while each player is funded through a
retained pool session anchored elsewhere. The source reader now follows the
exact hand/player/slot/epoch/pool/cash-session chain. It preserves the funding
club across chair removal and session closure, refuses missing or mismatched
custody, and leaves physical-table and retained-original custody unchanged.

The Saturday Mystery escrow was correctly closed at zero. Its chip shadow
reported prize+16/bounty-16 because two redeemed tickets each carried8 in bounty
in immutable ledger metadata, but the shadow counted their gross and omitted
that bounty. It now counts the recorded ticket bounty. No maintained escrow,
wallet, payout, rate or settled financial history changes.

Both migrations require exact installed preimages and readback, preserving the
original functions' owner, ACLs and configuration. The native PostgreSQL17
qualification reproduces missing Lightning attribution before, proves original
funding afterward, checks epoch/time/missing-evidence refusals and ordinary
physical custody, and demonstrates a ticket-funded bounty's shadow converges
to exact zero after its recorded payouts. Required accounting CI shard2 runs it.
Historical unaccrued attribution correction and installed readback remain
separate from these source changes.
