# tests/a-refunded-earlier-registration-is-not-a-second-entry.law.test.ts

Migration 20261024233030, installed first (as 20261024233424) to release a frozen never-dealt table and superseded by 20261024232734, is assert-only and marked SUPERSEDED BY 20261024232734 so no applier sends it, since production has been amended past the post-image it asserts; what production actually ran is recorded byte-exact in the 20261024233424 file.
