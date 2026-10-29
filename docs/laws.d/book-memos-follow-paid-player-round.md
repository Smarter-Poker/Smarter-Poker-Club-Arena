# tests/book-memos-follow-paid-player-round.law.test.ts

Optional book memo eligibility follows a canonical completed original player round. Before that, NULL keys make both original memo consumers return false without generation. After it, original generation, source/certificate/lifetime checks resume unchanged. This does not authorize payment or book completion, and never changes fee/barrier/source/calculation owners.
