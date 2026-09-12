# server/src/engine/aRetryThatCannotRunIsNotARetry.law.test.ts

A Retry That Cannot Run Is Not A Retry: The Hand Commit Step May Not Kill Its Own Engine Generation Before The Retry Budget Is Consulted, Because killForRestart Fences Synchronously And runStep Refuses To Retry A Dead Generation, So A Refusal The Database Rolled Back Whole And Asked To Be Run Again Leaves The Catch Untouched While Every Refusal It Made On Purpose Stays Terminal On The First Throw.
