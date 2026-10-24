# tests/lightning/lightning-readiness-names-its-tables.law.test.ts

The Lightning rollout readiness invariant `seven_tables` compares the exact set of lightning\_\* tables service_role reads directly (now eight, with lightning_horse_fill) instead of a count, still false on any anon, authenticated or PUBLIC grant; the law pins the eight names to tables the migrations create, so a new directly-read table is named on purpose.
