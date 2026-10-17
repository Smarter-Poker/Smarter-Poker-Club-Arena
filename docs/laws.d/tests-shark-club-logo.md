# tests/shark-club-logo.law.test.ts

Shark Club wears the logo Dan uploaded on 2026-10-16: the image ships at public/images/shark-club-logo-v2.png, every Shark Club fallback in the client points at it, and the migration that writes it to the club record and the club's social page changes exactly one row each and only while the old value is still there, so the install cannot overwrite a logo an owner chose later.
