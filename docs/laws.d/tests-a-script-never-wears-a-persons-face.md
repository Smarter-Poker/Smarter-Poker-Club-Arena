# tests/a-script-never-wears-a-persons-face.law.test.ts

A script never wears a person's face (Dan 2026-09-04: "KEEP MY ACCOUNT CLEAN"): no headless code (scripts, e2e support, server, workflows, root scripts) calls auth.signOut without scope local, Dan's personal address appears in no source, script, workflow or .env.example, orphaned local-credential probes stay deleted, and every retained probe accepts only an explicitly injected dedicated fixture identity rather than reading a workstation env file or guessing an account.
