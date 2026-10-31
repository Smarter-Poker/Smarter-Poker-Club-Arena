INSERT INTO profiles SELECT md5('p-'||g)::uuid,false FROM generate_series(1,103)g;
INSERT INTO club_members SELECT md5('p-'||g)::uuid,md5('club-a')::uuid,CASE g WHEN 101 THEN 'owner'WHEN 102 THEN 'agent'ELSE 'player'END,CASE WHEN g<=10 THEN md5('p-102')::uuid END,CASE WHEN g=99 THEN 'pending'WHEN g=100 THEN 'left'ELSE 'approved'END FROM generate_series(1,103)g;
INSERT INTO club_members SELECT md5('p-'||g)::uuid,md5('club-b')::uuid,'player',NULL,'approved'FROM generate_series(1,100)g;
INSERT INTO cash_participant_funding_receipts
SELECT CASE WHEN n=5 THEN ('ffffffff-ffff-ffff-ffff-'||lpad(g::text,12,'0'))::uuid WHEN n=4 THEN ('eeeeeeee-eeee-eeee-eeee-'||lpad(g::text,12,'0'))::uuid ELSE md5('fund-'||g||'-'||n)::uuid END,'buyin',md5('table-'||g)::uuid,md5('p-'||g)::uuid,
 CASE WHEN g%7=0 AND n=5 THEN NULL WHEN n IN(2,5) THEN md5('club-b')::uuid ELSE md5('club-a')::uuid END,
 date_trunc('week',(now()AT TIME ZONE'America/Chicago')::date::timestamp)AT TIME ZONE'UTC'+
 CASE n WHEN 1 THEN interval'-1 hour'WHEN 2 THEN interval'100 minutes'ELSE interval'200 minutes'END,
 '2026-01-01Z'::timestamptz+CASE WHEN n=3 THEN interval'1 hour'ELSE interval'2 hours'END
FROM generate_series(1,100)g CROSS JOIN generate_series(1,5)n WHERE g%3=0;
-- One irrelevant non-buy-in and a future admission must not replace a witness.
INSERT INTO cash_participant_funding_receipts SELECT md5('ignore-'||g)::uuid,'rebuy',md5('table-'||g)::uuid,md5('p-'||g)::uuid,md5('club-b')::uuid,'2020-01-01Z',now()FROM generate_series(1,100)g;
INSERT INTO ca_hand_facts
SELECT md5('edge-'||g||'-'||n)::uuid,md5('p-'||g)::uuid,md5(CASE WHEN g%2=0 THEN 'club-a'ELSE 'club-b'END)::uuid,md5('table-'||g)::uuid,NULL,
 (date_trunc('week',(now()AT TIME ZONE'America/Chicago')::date::timestamp)AT TIME ZONE'UTC')+(n%300)*interval'1 minute',
 'nlh',((g+n)%21-10)::numeric/1000,0 FROM generate_series(1,100)g CROSS JOIN generate_series(1,400)n;
INSERT INTO ca_hand_facts
SELECT md5('boundary-'||g||'-'||n)::uuid,md5('p-'||g)::uuid,md5('club-a')::uuid,md5('table-'||g)::uuid,NULL,
 (ARRAY['2026-03-08 00:00Z','2026-03-08 05:59:59.999999Z','2026-03-08 06:00Z','2026-03-09 04:59:59.999999Z','2026-03-09 05:00Z','2026-11-01 00:00Z','2026-11-01 04:59:59.999999Z','2026-11-01 05:00Z','2026-11-02 05:59:59.999999Z','2026-11-02 06:00Z']::timestamptz[])[n],
 'nlh',n::numeric/1000,0 FROM generate_series(1,100)g CROSS JOIN generate_series(1,10)n;
INSERT INTO ca_hand_facts
SELECT md5('today-'||g||'-'||n)::uuid,md5('p-'||g)::uuid,md5('club-a')::uuid,md5('table-'||g)::uuid,NULL,
 ((now()AT TIME ZONE'America/Chicago')::date::timestamp AT TIME ZONE'UTC')+(n-1)*interval'1 hour',
 'plo',n::numeric/1000,0 FROM generate_series(1,100)g CROSS JOIN generate_series(1,49)n;
INSERT INTO tournament_players SELECT md5('mtt')::uuid,md5('p-'||g)::uuid,md5('club-b')::uuid FROM generate_series(1,100)g;
INSERT INTO ca_hand_facts SELECT md5('mtt-'||g)::uuid,md5('p-'||g)::uuid,md5('club-a')::uuid,md5('table-'||g)::uuid,md5('mtt')::uuid,now(),'nlh',999,0 FROM generate_series(1,100)g;
INSERT INTO rake_attributions(id,hand_id,player_id,club_id,rake_amount,weighted_rake_credit)
SELECT md5('ra-'||f.hand_id)::uuid,f.hand_id,f.user_id,
 CASE WHEN substr(f.hand_id::text,1,1)IN('0','1','2','3','4')THEN md5('club-b')::uuid WHEN substr(f.hand_id::text,1,1)='5'THEN NULL ELSE md5('club-a')::uuid END,0.01,0.01
FROM ca_hand_facts f WHERE substr(f.hand_id::text,1,1)NOT IN('e','f');
INSERT INTO rake_attributions(id,hand_id,player_id,club_id,rake_amount,weighted_rake_credit)
SELECT md5('decoy-id-'||g)::uuid,md5('decoy-hand-'||g)::uuid,md5('p-'||(g%100+1))::uuid,md5('club-a')::uuid,0.01,0.01 FROM generate_series(1,300000)g;
INSERT INTO chip_ledger
SELECT md5('ledger-'||g||'-'||n)::uuid,md5('club-a')::uuid,
 CASE WHEN n%2=0 THEN md5('p-'||g)::uuid ELSE md5('event')::uuid END,
 CASE WHEN n%2=0 THEN md5('event')::uuid ELSE md5('p-'||g)::uuid END,
 CASE WHEN n%2=0 THEN 'player_wallet'ELSE 'prize_liability'END,
 CASE WHEN n%2=0 THEN 'prize_liability'ELSE 'player_wallet'END,
 CASE WHEN n=8 THEN NULL ELSE md5('mtt')::uuid END,CASE WHEN n=7 THEN 'pending'ELSE 'posted'END,n::numeric/1000,
 CASE WHEN n=6 THEN '2020-01-01Z'::timestamptz ELSE now()END
FROM generate_series(1,100)g CROSS JOIN generate_series(1,8)n;
