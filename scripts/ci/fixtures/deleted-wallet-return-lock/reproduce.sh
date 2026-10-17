#!/usr/bin/env bash
# Reproduces the 2026-10-17 round-3 deadlock on any Postgres 16+ (local only):
#   stage: clubs FOR NO KEY UPDATE -> wallet FOR NO KEY UPDATE -> pay -> clubs <late lock>
#   hand:  INSERT a row referencing the club (FOR KEY SHARE) -> UPDATE that wallet
# With "FOR UPDATE" as the late lock the stage dies with 40P01 "while locking
# tuple in relation clubs"; with "FOR NO KEY UPDATE" both commit.
# Usage: PSQL="psql -h HOST -p PORT -U postgres" bash reproduce.sh
set -u
P="${PSQL:?set PSQL} -Xq"
$P -d postgres -c "drop database if exists dlrepro" -c "create database dlrepro" >/dev/null
$P -d dlrepro -c "create table clubs(id int primary key, chip_treasury numeric);
 create table club_members(club_id int references clubs, user_id int, chip_balance numeric, primary key(club_id,user_id));
 create table rake_records(id serial, club_id int references clubs, amount numeric);
 insert into clubs values(1,100); insert into club_members values(1,1,10);" >/dev/null
run() {
  $P -d dlrepro -c "update clubs set chip_treasury=100; update club_members set chip_balance=10" >/dev/null
  ( $P -d dlrepro -At -v ON_ERROR_STOP=1 <<SQL 2>&1 | sed 's/^/  stage: /' &
BEGIN;
SELECT 1 FROM clubs WHERE id=1 FOR NO KEY UPDATE;
SELECT 1 FROM club_members WHERE club_id=1 AND user_id=1 FOR NO KEY UPDATE;
UPDATE club_members SET chip_balance=chip_balance+5 WHERE club_id=1 AND user_id=1;
SELECT pg_sleep(1.5);
SELECT chip_treasury FROM clubs WHERE id=1 $1;
UPDATE clubs SET chip_treasury=chip_treasury+5 WHERE id=1;
COMMIT;
SELECT 'stage committed';
SQL
  )
  sleep 0.5
  $P -d dlrepro -At -v ON_ERROR_STOP=1 <<SQL 2>&1 | sed 's/^/  hand:  /'
BEGIN;
INSERT INTO rake_records(club_id,amount) VALUES(1,1);
UPDATE club_members SET chip_balance=chip_balance-1 WHERE club_id=1 AND user_id=1;
COMMIT;
SELECT 'hand committed';
SQL
  wait
}
echo "== late lock FOR UPDATE (before)"; run "FOR UPDATE"
echo "== late lock FOR NO KEY UPDATE (after)"; run "FOR NO KEY UPDATE"
$P -d postgres -c "drop database dlrepro" >/dev/null
