CREATE TABLE fixture_concurrent_chain(context jsonb NOT NULL);
INSERT INTO fixture_concurrent_chain SELECT fixture_chain();
