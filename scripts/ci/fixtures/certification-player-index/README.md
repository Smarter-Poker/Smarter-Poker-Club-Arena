# Reserved cleanup player lookup

Production05:04:58 join failed55P03 while another reserved cleanup held the club hierarchy lock for51.57seconds. The unchanged cleanup deletes membership before Auth deletion; the Auth FK checks accounting_cash_rake_sources by player. Its existing composite index leads with rake_record_id. A read-only matching lookup exceeded8seconds.

The fixture captures exact cleanupf29271b8f640a2d2a1f04e6f020e150c and hierarchy trigger2bf2e0dc1876c5b1238603fc18558907 onSeptember27. It reuses the maintained retirement schema/helper migration and adds the real NO ACTION player foreign key and composite index with many unrelated rows. It proves actual full cleanup behavior, unchanged FK refusal/rollback, original hierarchy serialization, private role access and real online-index writer compatibility. It does not simulate every production child table or claim hosted Auth deletion proof.
