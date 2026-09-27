# tests/the-database-keeps-nothing-of-sentry.law.test.ts

The migration that removes the last Sentry objects from production drops them in one transaction without CASCADE and replaces each remaining function over its exact production pre-image, changing only the words that named Sentry.
