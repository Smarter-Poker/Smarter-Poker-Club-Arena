# tests/the-database-keeps-nothing-of-sentry.law.test.ts

The migrations that remove the last of Sentry from production drop its objects in one transaction without CASCADE, replace each remaining function over its exact production pre-image changing only the words that named Sentry, and delete the one archived configuration row that named it, asserted before and after.
