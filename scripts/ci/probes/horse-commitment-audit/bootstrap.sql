-- Disposable fixture only: use the provider's already installed pgcrypto.
-- This does not install packages, define substitute digest code, or touch a real DB.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
