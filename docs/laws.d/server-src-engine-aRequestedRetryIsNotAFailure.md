# server/src/engine/aRequestedRetryIsNotAFailure.law.test.ts

The post-commit obligation loop does not report the first attempt of an F06_RETRY_CANONICAL_LANE answer, which is the database asking for the same transaction again before writing anything; every other first failure, every tenth attempt of any cause and the critical give-up alert are still reported.
