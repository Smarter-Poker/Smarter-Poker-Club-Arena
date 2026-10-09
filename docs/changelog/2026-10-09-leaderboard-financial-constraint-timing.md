# Leaderboard Financial Fixture Constraint Timing

Actual payout baseline 37899742153 failed with SQLSTATE23514 at inputline398, the real Bank-to-Promo funding block before payout cases. The shared authorization fixture validated its state with SET CONSTRAINTS ALL IMMEDIATE and left that mode active for the companion. The production journal checks are INITIALLY DEFERRED and validate complete balance/journal writes.

Keep the authorization validation, then restore deferred checks before the financial companion. Every companion retains its own final IMMEDIATE validation or COMMIT; invalid complete writes still refuse. This corrects disposable fixture execution timing without changing a production function, trigger, constraint, actor or amount. Signup HTTP fixture section bytes remain unchanged. Both financial generators pin the reviewed shared input.

Native PostgreSQL17.11 mechanism proof used eight unchanged actual functions and seven exact trigger definitions: immediate transfer refused23514; deferred20Bank-to-Promo transfer validated at the final immediate boundary with Bank99980, Promo20 and two journal legs; a missing-leg negative control still refused23514. This limited fixture is not full current-schema financial qualification.

Validation:29 focused generator/signup/source tests passed with zero skips; compiler, scoped lint, formatting and diff checks passed. Actual changed baseline and all prospective modes remain required. Frozen consolidated migration and postimage are unchanged.
