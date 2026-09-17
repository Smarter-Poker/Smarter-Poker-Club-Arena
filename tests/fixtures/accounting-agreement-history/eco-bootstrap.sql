CREATE TABLE unions(id uuid PRIMARY KEY,settings jsonb);
-- A pre-existing explicit setting still supplies no observed historical coverage.
INSERT INTO unions VALUES(u(80),'{"eco_enabled":true,"eco_base_mode":"club_cash_profit","eco_rate":0.1,"eco_include_horses":true,"private_note":"excluded"}');
