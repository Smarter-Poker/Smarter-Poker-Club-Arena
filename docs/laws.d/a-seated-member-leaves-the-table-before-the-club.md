# tests/a-seated-member-leaves-the-table-before-the-club.law.test.ts

Launch audit, 2026-10-05. `fn_member_leave_to_treasury` deleted a membership
without looking at the felt, so a member could leave a club while holding a
live seat funded from it, and that stack then had no wallet to cash out into.
Migration 20261006024809 refuses the leave inside the function, for every
caller, while `table_seats` holds a live seat for that member and club. The law
pins that the refusal sits before the chip return, that the migration refuses a
definition it was not written against and asserts its own effect, and that no
later migration redefines the function without the refusal.
