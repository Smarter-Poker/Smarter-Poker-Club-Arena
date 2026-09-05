# tests/a-script-never-wears-a-persons-face.law.test.ts

A script never wears a person's face (Dan 2026-09-04: "KEEP MY ACCOUNT CLEAN"): no headless code (scripts, e2e support, server, workflows, root scripts) calls auth.signOut without scope local, and Dan's personal address appears in no source, script, workflow or .env.example; the account a script uses comes from SP_EMAIL / TEST_USER_EMAIL in .env.local, and a script without one refuses to guess
