# tests/signup-never-freezes.law.test.ts

Signup never freezes (2026-10-16): the platform freeze guard lets a zero-balance wallets INSERT through, so an account created between :55 and :00 still gets its player wallet from the one-shot signup trigger; every UPDATE, DELETE and nonzero INSERT on wallets is still refused.
