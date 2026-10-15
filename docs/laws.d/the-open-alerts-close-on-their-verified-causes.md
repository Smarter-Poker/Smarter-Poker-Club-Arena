# tests/the-open-alerts-close-on-their-verified-causes.law.test.ts

Migration 20261015101531 closes only alerts and drift incidents whose group re-asserts its verified cause in the same transaction (the paid freeroll, the fixed leave_pending causes, the unscheduled money check board, the healthy settler, the resumed Free Buy board), moves no money, and leaves every alert that is still true open.
