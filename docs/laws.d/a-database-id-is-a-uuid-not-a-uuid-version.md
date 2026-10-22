# tests/a-database-id-is-a-uuid-not-a-uuid-version.law.test.ts

Client code validates ids read from the database (users, clubs, unions, recipients) with the shared shape check in `src/utils/entityId.ts`, never a uuid-version regex. Midway Union (`fade0000-...0001`), The Felt Society (`a0000000-...0001`) and every horse (`00000000-...00NN`) are valid uuids that a version-pinned check refuses; it blocked every Union Bank pull back and every Felt Society or horse agent transfer. Client-generated operation ids may stay version-checked.
