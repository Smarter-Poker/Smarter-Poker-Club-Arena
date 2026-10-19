-- Taken after 20261019021553 (fees) and before the net change, so the after
-- check proves fees, hands and rates are exactly what that migration left.
CREATE TABLE mtt_money_baseline AS SELECT ca_club_member_statistics('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002',NULL,NULL,NULL) s_all,
 ca_club_member_statistics('60000000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000002','nlh',NULL,NULL) s_nlh;
