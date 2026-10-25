# tests/a-refunded-earlier-registration-is-not-a-second-entry.law.test.ts

Migration 20261024233030, installed first to release a frozen never-dealt table and superseded by 20261024232734, is assert-only: it runs after the superseding migration, changes no function and no row, and refuses unless the never-dealt proof holds exactly that migration's post-image.
