# tests/commission-accrues-for-every-agent-in-the-chain.law.test.ts

Cash-hand commission accrues for every agent in the chain: the accrual guard carries the agent's user_id below the agent lookup, so the second, third and fourth agent of a hand are booked; the unique (user_id, source_id, source_type) key and ON CONFLICT DO NOTHING stay; nothing backfilled
