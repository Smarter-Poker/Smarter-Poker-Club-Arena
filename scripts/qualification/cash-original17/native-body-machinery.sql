CREATE FUNCTION smarter_private.original_tournament30_source_correction_proof(e uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE x record;s smarter_private.hand_submissions;h smarter_private.hand_submission_handoffs;z smarter_private.hand_submission_handoff_results;p smarter_private.f06_hand_permits;stack_hand uuid;
BEGIN
 SELECT * INTO x FROM (VALUES
('0945dbd3-c650-4479-a536-1742217a2ec0'::uuid,'929b7e3f-d15a-42c7-b06e-62dd6d350618'::uuid,33736626,'1653c1f91fcd60a766e5e2563ced1acdb3e8c9f2df49a11d182e2f218c77a6c5','2482b488ca31a25623fd025f223d4479','9f35f1234b42931f7d3ce53a06cef9c8','3f252a761fa8b46e0c6057115ca3f2e1','a500fee7-57e8-4f39-9877-6ed81f1e8635'::uuid,'44836c931664090cd19183d4345547d4','e15326be807a8823a9f67a5650681ea8'),
('105a9907-49cf-4096-b0fc-2be7a721228c'::uuid,'8dc9df6a-73fd-484a-a9bb-a25b22e7d274'::uuid,33737494,'3c23fbbaf9797aabca9bd4a0305feae19baa937133f8ed4047bdb200361f9952','d110af43d796f22e633ee12bf18c44e1','f653cd0c9d00b77f0dbcbe2402ce91ff','7b30550a3a058ae538d03f62a26c2111','012f0006-11ca-4d7a-9cbe-e648d28393dc'::uuid,'a9ef02455b9539f6ad544b4fab1eb9ca','4c69f2cba5c8f0f33fff3f481db0f535'),
('1fa41967-8611-40dc-b724-edc4f2929a6c'::uuid,'e46b9128-bd44-4b90-b321-786716838dbf'::uuid,33737489,'20a8c68e1f2b8c8bce046cbbf7cfa1207432448662a8f82459dfe3cc72187288','2566e27a52f3e0680d5a27be8000f725','85ac37f87b518d5478daed24bb636d6f','37ab735d02a3d3c1ca47922bb3cc3a5a','b7f8e7cf-dc94-4208-b73e-b0ecb2332792'::uuid,'9645d571c8408a73f6aeef856536f1f9','d26d32f980b010a521bbc9870606b21c'),
('20626e7d-1470-429f-8761-cc089677a0d1'::uuid,'eff44da5-c2b9-44c7-bbd6-ec24d0480150'::uuid,33737556,'a7ff40411c7cc5df8c1dafcd3b184fb49f94afe3526ff23bca609ebde48cdb54','454f3b6d5140535279c148890e3adef8','2625149064a9050ffc61bfe808920cf4','04e8dab8de34ee57632be73fb46d5c00','c45477cc-0755-484e-862f-049de73a6c72'::uuid,'efbaadff149eb549d7986cd058511e32','330a2ae2e3f2348d2d617456b74fe8ae'),
('2ad46d92-7144-484b-8bf3-ede0cd19cc4e'::uuid,'b060b966-56e0-4f82-8ea7-83a9d3cfb3a1'::uuid,33736699,'8a4f78ba04fb6717206d039e89949dd1aa0bedfdaac8cf6bc6b4697de5bcb0d0','86300882364760083e36255a4431d226','42a13ee83def3da03ded5c2af7948c06','9394abcc55a7b15b43751d74746a0370','e8872636-d19b-4c97-ab70-b1e174513101'::uuid,'6ca4c0456de406f2fcda45611f3ded3c','c3b77bb61a1ec17479fc7cde6d2b9891'),
('33b3a4d3-d0df-4308-a602-2f007de7d744'::uuid,'42cfcc4c-b983-458d-ba36-4ca697a215d3'::uuid,33737530,'8b4dfe8e8beedbc6a515ba79209ca8c9f3850d358ef28cbdf80577721716e5b7','deac3b03f4320e513795f368ca0eb74d','608883039549df38a9cf1de66060fbca','13dfcff9ed628b2559fa9b17070952a8','8e82c6f0-8477-4f9b-a29e-8f626f2a1078'::uuid,'d0dbc3e4736bb4f8f5d3e454adaca97a','a270304c632403316417b35ef0e9a7d9'),
('515aa2db-425b-4328-9100-3cd823e97d81'::uuid,'771cda5f-9563-4b5e-baa2-30395770983e'::uuid,33737617,'6b41fd0e8b68a24b35e5ce7fb32a6acd8588a45b96b375ca8ccd4bcefb1bc6e0','e11ccb423fd1b11bd38aaa671162d040','e144ba7059f571585fa923c369128580','a8af618963730369ab3f72089ace2f1c','91539fa5-0047-45a2-a5e7-18b1ea4f8d3f'::uuid,'f59e887377bdda24d8f5db8c342fc783','58f7932974eda512a2af5b6448c01758'),
('5ca21a93-d89f-46f5-a132-e0d2a60f0fe2'::uuid,'445eca12-54a0-4cd6-801b-efe2f46542fb'::uuid,33737448,'cdb810473e4ebcd7fa50652d53eff8dd6d9416908e6ce47a311e62b348adc486','2523a5c67cc23f5389a4f2b77627d5d3','a4b71708c151beb08e3b235565ff24fa','f2e269c09587c19a0ad47ce9da841739','a5a3de62-febe-49cb-9914-75c6ff1599ea'::uuid,'b903479da3850a357074e1228645dc96','a25b6b9bb97e84e9a661c65df2fec054'),
('9596aed7-5261-4d12-b524-2499d1f35095'::uuid,'f13dd75a-c78d-4dca-bc56-4dc8724b6b39'::uuid,33737127,'74fec8603e1e1a1afd55ae607a4f8947c604a0217519a059287ee07d9c381c7d','2d27af4e123618020e4e19c9aa0e7e06','ed0302a8699a4f75ad2bd34a0be388c4','0a53e14f946d7fa341ff82c0c0f928a7','ae94f23e-eaae-4eec-80e5-ab8ab9545848'::uuid,'9966dac286379ff4639a41362237af2c','379e05f32e2452f41594ef98091990ec'),
('9aae1c79-e84b-44e9-a2c5-b03f452e3244'::uuid,'c32fcf03-abdc-4310-a681-e6d52432ee9c'::uuid,33736130,'58ff506d6759eefa94a4aa7ce332ecc82f97d10f3da952d0c95e686096a1ab92','519f242b8f2a18d8ca9c89f29e29c2e1','b0f547ff4a16595b568c42334bcacd48','e195f273716a13b7e7f37efb7c228726','768ce66b-f579-4920-9cbe-4597484f9b8f'::uuid,'40c64d0359ebefdce5ba1c4110338829','2434fa0cca8ae0f84df449da42e0a817'),
('a0b8e9b9-5a31-4281-b281-6aa4234e2aa4'::uuid,'5b34352d-bcc6-46d3-ac31-5a8d03c97346'::uuid,33737287,'f5615ea975425749276d0140f234e19d4160fb7d31a8a9b6889805885bf68d01','103ae657b3a7d23fc071625a57860563','2ef72c7234d581f68582d779257db546','9c3378f9907cf3c2b548d8d6d733b5a1','3be14515-60f8-4863-bcd6-1b680325bc5f'::uuid,'bf5d8a3b29637c67b855b4ce5e9141d4','12e8099ff4f0dc2bdb0b51b000911f51'),
('ce78a269-cd96-45f0-8a38-16cbd43cce07'::uuid,'0a35c345-bf7f-427e-b758-8ee38b708751'::uuid,33737097,'8b70e8070f8f0569a4017367ace2462d346043f56bf0bef7b9ebf4a5099c03cb','43c249a33f0edb782dbb9c5b58c96220','11f1a0ffeb79d19cd7d82d36732fa808','7919c1c353267fab9b829779c1c9efb4','fb7fdebb-aa4c-4159-b769-3c87986dad4b'::uuid,'70abcf1f4245a6ccf8b052dcc4e2d5aa','85281bb20303b8745c62549f84157c27'),
('e18f4150-3884-46eb-a1fb-189847df1a03'::uuid,'41e3b325-1a89-4f27-b143-8cf96bd7f417'::uuid,33737499,'017f14c9340ac9c4cc5165d7e8d0059bf0f99a6c88dba363dd33c5ce541c4778','acbed8c7a32d350206ef5ad6ed81bfc3','330c02b29bbfc12259bb4031b84ad8ad','6918ea25a0df5dc3571bef368f8dac59','8a609ccf-36bd-4376-ac96-aea1f04865f7'::uuid,'ece0d864671ef8fbda285c3c1d293c0c','b0aa1e6d160c044e4b85c7bae7dc6d0b'),
('e36cd364-32af-4467-880b-e9f5bd2d8b19'::uuid,'e3ad386b-5028-4934-b027-bbdb23342390'::uuid,33737590,'78550937fa136497a4725c1830b7d1654cbcaf144c32dafca1e8acba36bc9d5a','cae5c3eeb8ba5439ca4024037f13e888','9d2caa9aeebb0d87115c0cbe72bd6b8c','7fbd1f08da2861a149b4e646caa5087a','2084ff13-8fcb-4c75-a12e-6677eedefcbc'::uuid,'7d2394f43f520a9cd07f99826fa4192f','34ea6b950e82a65c20695734acd18476'),
('edb94d4b-4c0a-4a1e-95b7-5e76759180ee'::uuid,'12109654-1b5c-4a82-b470-400e2c2c6b52'::uuid,33737230,'78fd18616cbf0a2d5834d842e639ffe1fcbdbdd5969d0e28239e99057a6c99cf','4f2dc1262bf5ef4ce7b40ce606cab4c6','202c3cd1f0eb06768af0eecceb2801ac','157b5ae7b7e707f661a57a36f9548be0','a16ac846-3a98-482d-905a-43da6fbc1424'::uuid,'71882d781c4019255f2d230e9092fb83','5688344a158551943d396ba3a6813eb2'),
('f9eed0b6-785b-41da-bcd3-c7d00c8535f4'::uuid,'acd0939a-3a58-4ae9-bdd2-6327e4b2b513'::uuid,33737141,'883863eac5abdabcff0d0ba59e1d050b0c841db681435383d4ee7af8ce33aeec','b8f7955758c9b035ff5c85b2df98aa8b','5054934534d52883370f3664a0436553','44868eb6e82efe5af84b4c466b57bf18','a065fb44-9f69-4bed-8817-c56fe5a71a5a'::uuid,'47618fbdf8dc9be536142d22eed04dac','205170c643841c62236f08460a3ab874'),
('fc5f79e0-0a9b-4662-8aa8-85665a3bae07'::uuid,'bfe9674c-32c5-40b3-b397-5bb1e9a8e8d5'::uuid,33737229,'5df9bed0606dcef58f4c2bd9b47c1b63ac104869d94b070f854dd516c0bfd0de','505e0daf6999567a79a1631ecadc856b','a32cd00e4606b0334aa68d99e3f71f93','5f61fc5a7959667485713b2def0d2a45','141a3292-796f-419e-8030-9c92ad939ac4'::uuid,'ad1af6171e12e60107d102d85f213d20','dd733f5b1bbaa2f3d67d86fa1c9b5efe'),
('fd0abfa3-b0cd-4196-a1a5-4522ba8733ee'::uuid,'fdc83055-e5b3-45cb-bdc9-5eadaf6753eb'::uuid,33737457,'bb69d5ef907a182726437a024daff19dfc1a0890cc5742629e91fb46f26cba46','5ead86134c51de0da3a68ca6079c4c86','9b04e4b62afa76866921e829d827d6c5','596729632b85dbabc3336c674aeb0962','b6228f08-77ff-4d1b-af43-db2757df5f74'::uuid,'597a0890a05dc09896e87540728c7bfe','30c14771a7fd59a4d882dacd6df6f3b9'),
('583f3b5f-b68a-48b0-a0ee-e9cbae519366','108ab441-0311-4f38-8e65-c99bd97fe26b',33776323,'c6a93e33934d0346ba765c0079a34d183ff6080901df9790c1f429dbd690f00d','b46ebaaeaa5ad5a7a7f7d067483716ab','c7a4f903bd30dcf309b4f14447f9e244','b38980cc0e4efc410a9665f5c10cbf9c','207506c5-72b8-4184-88b9-8190a9b69d42','5ae3a2a2010cb0c7b9a3568e7cfc1234','eef42cab5357c593b993abea57b47af4'),
('08017ed0-8e0a-4685-99ac-62b432a444c4','d07308cd-a727-44b2-874a-76f5fa90c310',33776325,'2891045d55a8209584fca870b4bd95592cb3e38c1fcd0c7c94cb06c75743ebfc','0dbf4849f3631945e26e6e1a68a48c86','67385050b6905b0e299ad87be2f52e18','ed4695fa05ff6980501fb23512c0ed91','7e358032-1deb-476d-b743-c234cda66e5b','50ddd8469ef3a545bbd03bd78a748fd7','d0051b867964508a4790aa6fb2a1cd49'),
('860a67e6-fe1e-48b0-87d9-cfca56ec496c','da447c25-40ca-42a0-a709-cae35c3f33df',33776151,'8acfa4034c2491b78a58ef98049d9ced953d4e01bb8d27b4652293c106fcc85f','5a2323564d313d0fa9288fa4e41d7d73','03b77958a4bbc72dbcb4317d090e224e','b24934770e2a6248b90e773fed464420','73d0ba3b-3c06-4aad-a50b-709fd255b116','4701c87128524e02cecf4a53ab52808d','173c0f87d0f18184f6a380b09943f6fc'),
('c91c795f-6991-490b-a892-8487bd52b9c7','efc13493-caa9-49ca-8681-3b2542e3ddbd',33776330,'34ce8f783519d4c23e18e97d129182f4a7f4a4073e522f9c187b6550da2b21c1','618c69177c76720d73bb470f446feecb','28df096ca56c7222143ff1bcf93b7310','40dae9a96077d0c3096996149425f84a','79a5fca8-433b-46cb-be14-34b9f2080df7','14e24f494966558c8492e997f6dfc93c','00e727db293ec252c223a8b03b358e7e'),
('1e335ceb-2be5-4749-885f-c4457be3e300','e95b9def-6834-4159-9a64-dbf4c7fe689b',33776329,'76f3de8a2962c2633983fa1842262c1acc971523d2fbc794b882087fe4f6628a','45d00efbc9247939a5d21ed11b704d26','5e2ffb6188ad278a27d82e6594dc974e','4faaac8a05487ca5d5417934298e1683','ade049ea-3e4c-4f1b-a6b7-8f96cebf9984','d64837f60d893727c7c177f3f1887c65','95ecdebede0a8518be1dd4318dffd6d0'),
('69f549e8-adb0-43f3-aaea-0c8b93d033ea','015a1960-6974-48ad-aa43-4cd7649e0c87',33776147,'150fc8530ea6beae423a87bd2433a49d8e94016f4c28102982495558bcd6509d','9c3c172613442cb82a7a6ec32cb67956','976de1390e4da3b00d59b9785dabb73f','8cb533200826182d4665a4598d463701','56456d80-71bc-4af0-8168-ce5f1e741cbf','9d1ce770bef45e08b854a8960ffe05c6','49e59c658b1505d9cfa48ca361bd8a99'),
('5a552ee7-ea42-48a3-b2d2-eb6a1de982e5','3d5940d8-a2bb-4c8e-8e1f-4d4a9d8802e9',33776150,'603c622fd29ecb6b11f25f0395432b28e9971484543c540d6bdd0b3e38a17606','64385631dfc40851910823fd490a351f','11ba04dbee07adba31cf88ecf057cd72','b29daa6c9d0b7fe7b175afd9680c1541','0a9a3882-ea65-4e8c-a7a4-e03e227267e9','71bb7d6be373f47307649bca7f036e75','8778f39c1327a0b4ab73ba7cf0ff2c50'),
('e55544ff-34b5-43eb-8928-de442f2f69ca','10a5d280-73a2-424a-9e40-c242e1ddc0e7',33776339,'2f10fa94d4265cf796308934e532653999666ba9f41f78ca3a5e61155a09e7bc','09b75724ce33ccaf5f504177d63a4024','6a0cac459eabd0bdd6b569b92389751c','7523f0edf1d245d6314782f9a06f2fe9','ca18f439-9847-4c49-84d0-a98267afa591','a17d1bad8ed83b79205337fc55754560','8f094078e36f8cf72bff254e1ea3110e'),
('36e067bf-e7bb-4905-9d4b-afa7f330ca83','f7c12144-b30c-4928-89e7-0e316f501110',33776328,'7cf9e4111d40363e1ab303f8806952d75fb999ae2bc56d6f4d9ebe17ff3567f1','8bc22aaf218381231aea058f9e141e76','dbc24a78b2218ff82b098459bd42ce92','9aae6d49f5e801964aadc3f2cb9ee3c7','178f89e2-f6ec-4769-8c8c-281fcc21c12d','6dfa8431ea5419517f3613857bf0a39c','a27e1714fe6c1b44f63102ca87ed3c4d'),
('b739b7a7-75e3-4f96-a363-e6434bb7365b','513b7b63-357d-43e0-9591-fe090d6bc5c5',33776324,'386dd488311c622a4c396dd43a4e57cfce78bad418f11d35ef3da3cd6c96b0bc','79d8f27f6ba4d89108ee85606857b72b','88d6619cb0224b1a70382f999a047935','1fa6a4a2ff56588f0f8ee6c518e8fea5','15eeef98-5462-4e10-9a98-07813952057c','488d01d0e6eeada5103d78d3087ef5a6','fb1a67c206cc6d45649b8d8fa55cf360'),
('22e74d55-5176-40fe-9feb-4f58f5397e3c','fdea37f9-7e94-4957-9594-50c2e8560cc4',33776331,'8102e0da5319dde9fe8099b2d4b191c430f299cd993cf610771666ae12dc647c','ed4ec68a84b89453c93583ff29287552','d358b917f852c5c4492505f80b7e726a','fd1834ee674f31d4859c5694f813bc78','61ce0dc9-a7ea-4d13-8064-6d65fa3d48ea','ff03d61c5c911bcaf198beeb0ccafba0','9ad895128e86da1e3b44747fc863735f'),
('81213af3-d6d9-4772-966d-47bc7fe4b220','ce7a06b8-3c05-4c0f-89e6-d539698637a1',33776326,'1f9780027dc663658d642f9ea86ccb64ded3ae99ff7fdcfd89ce7b4afba0e27e','120a32b1c4e7af6061956ef0ddc38a4b','c596f321a3428b81948678594588d64d','01246b00404a04616d9338fe276fc295','7504ca26-7bad-48d0-9b4b-40bac1a52c8c','df80c78cb2af6da6e9de5918590848b9','a82a7b01c50c1f9a75caa8d404d4e532')
 )v(submission_id,table_id,hand_number,request_hash,request_md5,handoff_md5,result_md5,permit_id,permit_md5,snapshot_md5) WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=e;
 SELECT * INTO h FROM smarter_private.hand_submission_handoffs WHERE submission_id=e;
 SELECT * INTO z FROM smarter_private.hand_submission_handoff_results WHERE submission_id=e;
 SELECT * INTO p FROM smarter_private.f06_hand_permits WHERE permit_id=x.permit_id;
 stack_hand:=md5('ca-hand:'||s.table_id::text||':'||s.hand_number::text||CASE WHEN coalesce(s.request->>'p_ref','')='' THEN '' ELSE ':'||(s.request->>'p_ref') END)::uuid;
 IF smarter_private.original_hand_correction_sources_match() IS DISTINCT FROM true
 OR s.submission_id IS NULL OR h.submission_id IS NULL OR z.submission_id IS NULL OR p.permit_id IS NULL
 OR s.table_id IS DISTINCT FROM x.table_id OR s.hand_number IS DISTINCT FROM x.hand_number
 OR s.request_hash IS DISTINCT FROM x.request_hash OR md5(s.request::text) IS DISTINCT FROM x.request_md5
 OR md5(to_jsonb(h)::text) IS DISTINCT FROM x.handoff_md5 OR md5(to_jsonb(z)::text) IS DISTINCT FROM x.result_md5
 OR z.result->>'reason' IS DISTINCT FROM 'successor_authority_refused'
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,kind}' IS DISTINCT FROM 'none'
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,version}' IS DISTINCT FROM '1'
 OR (s.request#>>'{p_hand_row,tournament_id}')::uuid IS DISTINCT FROM p.tournament_id
 OR z.result->>'error' IS DISTINCT FROM 'diamond_jackpot_wrong_hand_scope'
 OR z.result->>'sqlstate' IS DISTINCT FROM 'P0001' OR z.result->'success' IS DISTINCT FROM 'false'::jsonb
 OR z.result->'atomic_hand_commit' IS DISTINCT FROM 'false'::jsonb
 OR p.table_id IS DISTINCT FROM s.table_id OR p.hand_number IS DISTINCT FROM s.hand_number
 OR p.generation IS DISTINCT FROM s.lease_generation OR p.state IS DISTINCT FROM 'reserved'
 OR md5(to_jsonb(p)::text) IS DISTINCT FROM x.permit_md5
 OR (SELECT count(*) FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete) IS DISTINCT FROM 1::bigint
 OR NOT EXISTS(SELECT FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete AND md5(to_jsonb(a)::text)=x.snapshot_md5)
 OR jsonb_typeof(s.request->'p_stacks') IS DISTINCT FROM 'array'
 OR jsonb_array_length(s.request->'p_stacks')=0
 OR EXISTS(SELECT FROM jsonb_array_elements(s.request->'p_stacks') original_stack(value) WHERE NOT EXISTS(
  SELECT FROM public.table_seats t WHERE t.table_id=s.table_id AND t.id=(original_stack.value->>'seat_id')::uuid
   AND t.user_id=(original_stack.value->>'user_id')::uuid AND t.joined_at=(original_stack.value->>'seat_joined_at')::timestamptz
   AND t.left_at IS NULL AND t.stack=(original_stack.value->>'stack_before')::numeric))
 OR EXISTS(SELECT FROM public.hand_projection_outbox a WHERE a.hand_id=s.submission_id)
 OR EXISTS(SELECT FROM public.poker_diamond_jackpot_hits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number)
 OR NOT EXISTS(SELECT FROM pg_proc jackpot_source WHERE jackpot_source.oid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND md5(pg_get_functiondef(jackpot_source.oid))='0db3d6146f5e1118c570ded9bfb5261f' AND pg_get_userbyid(jackpot_source.proowner)='postgres' AND jackpot_source.prosecdef AND jackpot_source.proacl::text='{postgres=X/postgres}' AND to_jsonb(jackpot_source.proconfig)='["search_path=public, pg_temp"]'::jsonb)
 OR (SELECT count(*)=1 AND bool_and((t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='d520254027350e60b03aad1f1a73747a') IS TRUE) FROM pg_trigger t WHERE t.tgfoid='public.fn_poker_diamond_jackpot_accept_hand()'::regprocedure AND NOT t.tgisinternal) IS DISTINCT FROM true
 OR EXISTS(SELECT FROM public.settlement_idempotency_keys c WHERE c.table_id=s.table_id AND c.hand_id=stack_hand)
 OR EXISTS(SELECT FROM public.ca_settlements c WHERE c.settlement_type='hand_stacks' AND c.external_ref=s.table_id::text||':'||stack_hand::text)
 OR EXISTS(SELECT FROM public.hand_atomic_commits c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM public.hand_history c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM smarter_private.f06_hand_permits c WHERE c.table_id=s.table_id AND c.hand_number>s.hand_number)
 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('submission_id',e,'table_id',s.table_id,'hand_number',s.hand_number,
 'request_hash',s.request_hash,'request_md5',x.request_md5,'handoff_md5',x.handoff_md5,'result_md5',x.result_md5,
 'original_generation',s.lease_generation,'permit_id',p.permit_id,'fixed_source_md5','0db3d6146f5e1118c570ded9bfb5261f');
END $body$;
CREATE FUNCTION smarter_private.cash_original17_fixed_sources_match() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
 SELECT smarter_private.original_hand_correction_sources_match() IS TRUE
 AND (SELECT count(*)=1 FROM supabase_migrations.schema_migrations WHERE version='20261013034406' AND cardinality(statements)=1 AND octet_length(statements[1])=12030 AND md5(statements[1])='c1d50ddeeb497dda34c5ef4481672396')
 AND NOT EXISTS(SELECT FROM(VALUES
 ('public.fn_poker_diamond_jackpot_allocate(uuid,bigint)','f6e42d6de56f5074f47403621fd46110','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_withdraw(uuid,uuid)','8ef3becaf9451c61696746ce57dee1e0','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_drop(uuid,bigint,bigint,jsonb)','7f7942a5318b29b53293dc7355d85f68','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_bank(uuid,text)','16efb5d2bb9b95406b4307cffedfc77f','{postgres=X/postgres,service_role=X/postgres}'),
 ('public.fn_poker_diamond_jackpot_accept_hand()','0db3d6146f5e1118c570ded9bfb5261f','{postgres=X/postgres}'),
 ('public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)','42026f4929fe2adc0aae9bfd307c516f','{postgres=X/postgres}')
 )v(signature,full_md5,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(v.signature)
 WHERE p.oid IS NULL OR md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM v.full_md5
 OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres' OR p.prosecdef IS DISTINCT FROM true
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] OR p.proacl::text IS DISTINCT FROM v.acl)
 AND (SELECT count(*)=1 AND bool_and((t.tgenabled='O' AND md5(pg_get_triggerdef(t.oid))='d520254027350e60b03aad1f1a73747a') IS TRUE) FROM pg_trigger t WHERE t.tgrelid='public.hand_atomic_commits'::regclass AND t.tgname='poker_diamond_jackpot_accept_hand' AND NOT t.tgisinternal)
$body$;
CREATE FUNCTION smarter_private.cash_original17_source_correction_proof(e uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE x record;s smarter_private.hand_submissions;h smarter_private.hand_submission_handoffs;z smarter_private.hand_submission_handoff_results;stack_hand uuid;
BEGIN
 SELECT * INTO x FROM(VALUES
('b11e8f0b-b606-4ff2-adc9-ddd911630938'::uuid,'53cbf1fc-2ad2-4f1d-ab19-f2168daea22d'::uuid,33776194,'318b6fd95da2844adfb5e0ddfa5c6e8daff450bad401a80f21cc6fc272273f21','86016f5e5a814b6effd029a1fe4898e8','e1619e73a257876868481776efa193aa','41fdceb9c477429f914ff0f3a3ffa46e','f7d5dd2c407bfce1c1debdf21d733b19','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('9e494cda-b171-4103-89bb-8f382dc8e372'::uuid,'3455dcd3-b7e0-4106-bd3e-3abe1c88cd58'::uuid,33776027,'bdbb9ce4db46534c7ef1885d464761c495b636484ac8e21e71ab80230f62480c','6dab803e676d0f909aaec504e0d90b08','c8cabd59704e9cdb61a05439c66b6245','e114ae9bf98d8064686a22515ead8f54','84be7d9efba51a3d5b5166cefd1ccde9','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('fd74e035-61f8-4b43-8dc3-18906b9eb831'::uuid,'7a68dc18-96e6-4b5c-904b-32de853a9c8f'::uuid,33777050,'c6b598d61045d86f7d90b41f7f80ca36405b76a5202528dbc4ed277c3b3c02b7','31cb904ce2dad2216d6569e8bdd3ad75','a50a440088d0e11635d339cfdf0aeb0a','a132881c0af05cae6a565e88a4968696','aed8ffee129463010b98d92cbf72c9d5','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('ad5663c3-6411-482c-86e2-6e2fce0dc672'::uuid,'0a462846-ae76-4671-bdfc-6a7729762b15'::uuid,33776219,'e5a1d4844a976a1697f3bc89634b4509b7220c1cd5293cc65dd343e31cb65b03','09fa4f15930c59cdc5abae70bf6fecdc','38291da235cb37966dee676c563f682a','dd26c16ca1dd430dc59b0b75b1f30c21','fa9fa8f936c4b050e20f52d1bae15b87','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('4147a2c6-130a-489b-9387-3ed82e01f189'::uuid,'b6f9bf9b-509d-4f8c-a2e5-02af9a51f23c'::uuid,33776857,'00c2e8a1ac75f5af50eb405228674d462ba66b8116bb2bc16e3f23fba87a2054','8326528c209d51366146be34c714b6c0','24ddb1993913c4eea6404a964488187a','de833e8773a589077d2b541878bf4c46','bf1fc1813f503885f898d0dba5bf3a5a','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('5a9f1834-76d8-4707-8a00-d21bbba8ac9c'::uuid,'a2efbe61-9a11-4045-9f6c-6513cefa3fbd'::uuid,33777014,'316be246b3ad213cce1a3028febc8b9992ab7186405642d8d11c755a9886f3d9','fe124f9e6fa592f5ab6241ec33dc126d','97b820b330ce5a83ad8d58e63bf630f7','138dea7c01c218860d189f2c4dd2cf15','09fb438db65c3b6fb579cc53f470c672','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('4c22c86c-e1d9-49ba-a17d-e0f64db6eef6'::uuid,'e33649da-165f-4605-a82d-aeb58d0516db'::uuid,33776923,'3a3ce442434c441e6ce737b6c820b4331d8738aac221268cfa5d505daa205bc0','da717e72ccf9ae2088fb183e3f39c533','c2cd85c2a63cb4cefd6159d6667f9567','5daba0bac31806743ac1940ad01ebdae','ea88d2f08ee47fab96bdb72a56198f3c','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('12eaef4b-69b3-40df-bc1a-2ddf4b4a67e6'::uuid,'ed68c9f6-7f71-451b-be3b-db0ed3be49ec'::uuid,33777549,'6ace3fe4b2d23b9995b822a50a0044da5a55ff7cae8745424869413dd05077cc','883fd03330d34ae447a10dc984e27e82','8ad608e729f37d08c242ff0b646fe2c8','9d2006009227be2d1b9f337205cbacc3','8a45f9ee478e61e6dfb0849454ec3ee0','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('aa13ae98-c982-472b-bb00-cf00dec3635b'::uuid,'e2c6a6b1-0d55-49b0-9277-b24d56b94b91'::uuid,33777650,'125e5a13bee312cd7077d3f271d42d8dde3ea228a7ba261e335d21f22f34f4da','4ec32ebc3fa41d8985e188b44669748a','5539164c93dd1336cbbe99331b87f3c1','fd5c8a9e455b204cfa14c20a38e527b4','710e4746f9ca472688cc309e8c6e1f32','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('e7c0ef54-df3e-4458-ab81-64e1e760ebad'::uuid,'12cd6ae2-290c-447c-85da-bfc3110b66b8'::uuid,33777418,'4011395d549ca16fd7affdc09dffb9c42f99beeaea582147a272ad30cf79d76b','aa18f20e5bd012dcb0491f4f0b932293','f540d729f4e4ed2971a9e61d31282383','42d4dee4bff9be2e66ec28eea3034848','61e10fb91531eb8c6455dd9d39df51f5','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('e796c474-114b-461e-abf5-99967fca1ee7'::uuid,'a89b6ae8-3430-493f-847a-2e30e81d8908'::uuid,33778211,'63d1cbbc7727891752f8b8b59de5cb8f28df6e69dfeb648d372c41825e1665e0','42810ee71d98f7ef9a2bbb39b6dee5a1','828ca1a28ba06204a18ad273f59e1f68','902663d91bf108747cceffb57bd334b2','b0784ed14190c5e46f4c81e89c9888ec','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('dfac5d87-f5c5-4fff-8d94-699173438afc'::uuid,'96bc1438-4b6c-4d6a-9e1d-16059752412e'::uuid,33778461,'bf42dec26abdea46a9cc628711ff9096d97e3c69fb1607fcf1e18c7944ba2e9a','8f9b1e15da3da3caf179961003d074a2','d099fad4687258cb0d3fd56367e35305','d01afbad328b9e8dd98f21ea15b47eaa','79fa0e5895c4c32baa03e9b18dd9906a','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('ccb60eeb-2c14-4453-a43c-315f29ad1f3d'::uuid,'0b50ea4e-441f-43c1-bbc4-977100a72130'::uuid,33778585,'71277ed2519a0f115057a6c7c9d34446bd6e652c004a4bc4d85ee066c32c7f5a','b20333e7551b051486c89af9372e8bc6','a0e70aa38a2e3f70cf0e4317b20d7356','9385cc07eeb5af1f94f22422bda63183','fd6dd0d9750cfc1943ae800626b7a4d6','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('4892e24c-448d-499e-a87d-ea2e4e5607bc'::uuid,'980bb855-cc5f-4ffb-a2d2-89e5ee80d443'::uuid,33778428,'d9db1d1fec5b04999e63ba7f6d081e20116b94c01ae2975f26f1f6744f94a355','4b1d50a6fb49783443db2b0b76f71fa8','a64b614e7d55b83c4750569af5b017a7','f32709886db8123cad87ed7838b4310a','6fb9a871a5d73f7aeb6e9a2a64fb4fc6','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('d0ba409d-53b0-483f-a9a9-a77de59ab811'::uuid,'a3d925c9-5021-4b65-93f8-0d711fda944b'::uuid,33779912,'31e392470e233681519357e6feff2e90a030ee49664ec1269e9c4dffdb7197c5','3e9df5cc52bdf98c82704f14bbda70d7','e0573be11b4698189be1448dda3adad2','4dab50d405a1b4d90e965c75b9c6fb0a','cff76800af5b0b8776e4b36a1e7f99d4','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('a0c51a66-02ec-4beb-9264-128d7b15470e'::uuid,'6e1b1d4e-3672-4ec2-ba3a-8c83465bd3ff'::uuid,33778876,'e6e3f3b7471a5f56cf0ba08b1630bf774bc99140a745b47deef8eef4ab3e33b4','1e73038e0ff5d1eb67781ad80d2e81b2','433fc726734acff671164406f20fb17c','a6f8817b69ee930edb43063f72014a91','8db181c81a2e28adb9aa75ab8386f1af','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid),
('de2e2b78-062a-4a85-805a-e1efb6dcf05a'::uuid,'979f84b0-6e1d-48e8-8f43-c27b0143f4d9'::uuid,33779645,'440f2ea39d38ad1f4f79d9cdf14981d95712eb901bf659dd60f1f2be3e4a3b5a','f246a51abf42f88b93313b2002944193','eb186a71293ded0ccbf7557ed8a468c1','eacbfbaffb1afec9f44f04be0dee8d90','3e47973495cc95481df694b27c71abf1','002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)
 )v(submission_id,table_id,hand_number,request_sha,request_md5,handoff_md5,result_md5,snapshot_md5,original_arena_id) WHERE submission_id=e;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=e;
 SELECT * INTO h FROM smarter_private.hand_submission_handoffs WHERE submission_id=e;
 SELECT * INTO z FROM smarter_private.hand_submission_handoff_results WHERE submission_id=e;
 stack_hand:=md5('ca-hand:'||s.table_id::text||':'||s.hand_number::text||CASE WHEN coalesce(s.request->>'p_ref','')='' THEN '' ELSE ':'||(s.request->>'p_ref') END)::uuid;
 IF smarter_private.cash_original17_fixed_sources_match() IS DISTINCT FROM true
 OR s.submission_id IS NULL OR h.submission_id IS NULL OR z.submission_id IS NULL
 OR s.table_id IS DISTINCT FROM x.table_id OR s.hand_number IS DISTINCT FROM x.hand_number
 OR s.request_hash IS DISTINCT FROM x.request_sha OR md5(s.request::text) IS DISTINCT FROM x.request_md5
 OR md5(to_jsonb(h)::text) IS DISTINCT FROM x.handoff_md5 OR md5(to_jsonb(z)::text) IS DISTINCT FROM x.result_md5
 OR z.result->>'reason' IS DISTINCT FROM 'atomic_hand_rolled_back' OR z.result->>'sqlstate' IS DISTINCT FROM '23514'
 OR z.result->>'error' IS DISTINCT FROM 'new row for relation "poker_diamond_jackpot_pools" violates check constraint "poker_diamond_jackpot_pools_backup_residue_check"'
 OR z.result->'success' IS DISTINCT FROM 'false'::jsonb OR z.result->'atomic_hand_commit' IS DISTINCT FROM 'false'::jsonb
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,kind}' IS DISTINCT FROM 'none'
 OR s.request#>>'{p_hand_row,_accepted_post_commit_facts,diamond_jackpot,version}' IS DISTINCT FROM '1'
 OR s.request#>>'{p_hand_row,tournament_id}' IS NOT NULL
 OR jsonb_typeof(s.request->'p_rake') IS DISTINCT FROM 'number' OR (s.request->>'p_rake')::numeric<0 OR (s.request->>'p_rake')::numeric<>trunc((s.request->>'p_rake')::numeric)
 OR s.request->'p_bbj' IS DISTINCT FROM '1'::jsonb OR s.request->'p_inflow' IS DISTINCT FROM '0'::jsonb OR s.request->'p_units' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT FROM public.tables t JOIN public.clubs c ON c.id=t.club_id WHERE t.id=s.table_id AND t.tournament_id IS NULL AND t.club_id=x.original_arena_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL)
 OR (SELECT count(*) FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete) IS DISTINCT FROM 1::bigint
 OR NOT EXISTS(SELECT FROM public.hand_state_snapshots a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number AND NOT a.is_complete AND md5(to_jsonb(a)::text)=x.snapshot_md5)
 OR jsonb_typeof(s.request->'p_stacks') IS DISTINCT FROM 'array' OR jsonb_array_length(s.request->'p_stacks')=0
 OR (SELECT count(DISTINCT v->>'seat_id') FROM jsonb_array_elements(s.request->'p_stacks')v) IS DISTINCT FROM jsonb_array_length(s.request->'p_stacks')::bigint
 OR EXISTS(SELECT FROM jsonb_array_elements(s.request->'p_stacks')v WHERE jsonb_typeof(v->'stack') IS DISTINCT FROM 'number' OR jsonb_typeof(v->'stack_before') IS DISTINCT FROM 'number' OR (v->>'stack')::numeric<0 OR (v->>'stack_before')::numeric<0 OR (v->>'stack')::numeric<>trunc((v->>'stack')::numeric) OR (v->>'stack_before')::numeric<>trunc((v->>'stack_before')::numeric))
 OR (SELECT sum((v->>'stack')::numeric-(v->>'stack_before')::numeric) FROM jsonb_array_elements(s.request->'p_stacks')v) IS DISTINCT FROM -((s.request->>'p_rake')::numeric+(s.request->>'p_bbj')::numeric)
 OR EXISTS(SELECT FROM jsonb_array_elements(s.request->'p_stacks')v WHERE (
  SELECT count(*) FROM public.table_seats seat JOIN public.poker_diamond_custody c ON c.seat_id=seat.id AND c.user_id=seat.user_id AND c.seat_joined_at=seat.joined_at AND c.occupancy_id=seat.occupancy_id
  JOIN public.tables t ON t.id=seat.table_id
  WHERE seat.table_id=s.table_id AND seat.id=(v->>'seat_id')::uuid AND seat.user_id=(v->>'user_id')::uuid
   AND seat.joined_at=(v->>'seat_joined_at')::timestamptz AND seat.occupancy_id=(v->>'occupancy_id')::uuid
   AND seat.left_at IS NULL AND seat.stack=(v->>'stack_before')::numeric
   AND c.target_id=s.table_id AND c.arena_id=t.club_id AND c.purpose='cash_seat' AND c.state='active' AND c.balance=(v->>'stack_before')::numeric) IS DISTINCT FROM 1::bigint)
 OR EXISTS(SELECT FROM public.settlement_idempotency_keys c WHERE c.table_id=s.table_id AND c.hand_id=stack_hand)
 OR EXISTS(SELECT FROM public.ca_settlements c WHERE c.settlement_type='hand_stacks' AND c.external_ref=s.table_id::text||':'||stack_hand::text)
 OR EXISTS(SELECT FROM public.hand_atomic_commits c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM public.hand_history c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM smarter_private.f06_hand_permits c WHERE c.table_id=s.table_id AND c.hand_number>=s.hand_number)
 OR EXISTS(SELECT FROM public.poker_diamond_hand_receipts c WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number)
 OR EXISTS(SELECT FROM public.ca_diamond_rake_accrual c WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number)
 OR EXISTS(SELECT FROM public.poker_diamond_jackpot_ledger c WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number)
 OR EXISTS(SELECT FROM public.hand_projection_outbox c WHERE c.hand_id=s.submission_id)
 OR EXISTS(SELECT FROM public.poker_diamond_jackpot_hits c WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number)
 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('submission_id',e,'table_id',s.table_id,'hand_number',s.hand_number,'request_hash',s.request_hash,'request_md5',x.request_md5,'handoff_md5',x.handoff_md5,'result_md5',x.result_md5,'original_generation',s.lease_generation,'scope','cash','original_arena_id',x.original_arena_id,'source_cause','backup_residue_constraint','fixed_source_md5','f6e42d6de56f5074f47403621fd46110');
END $body$;
CREATE OR REPLACE FUNCTION smarter_private.original_hand_source_correction_proof(e uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE proof jsonb;
BEGIN
 proof:=smarter_private.original_tournament30_source_correction_proof(e);
 IF proof IS NOT NULL THEN RETURN proof;END IF;
 RETURN smarter_private.cash_original17_source_correction_proof(e);
END $body$;
CREATE OR REPLACE FUNCTION smarter_private.hand_source_correction_claim_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,smarter_private AS $body$
DECLARE s smarter_private.hand_submissions;c smarter_private.hand_submission_source_corrections;proof jsonb;tour uuid;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=NEW.submission_id;
 SELECT * INTO c FROM smarter_private.hand_submission_source_corrections WHERE submission_id=NEW.submission_id;
 proof:=smarter_private.original_hand_source_correction_proof(NEW.submission_id);
 IF auth.role() IS DISTINCT FROM 'service_role' OR proof IS NULL OR c.submission_id IS NULL OR c.proof IS DISTINCT FROM proof
 OR NEW.request_hash IS DISTINCT FROM s.request_hash OR NEW.transaction_id IS DISTINCT FROM txid_current()
 OR NEW.lease_generation IS NOT DISTINCT FROM s.lease_generation OR public.fn_platform_frozen() IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_CLAIM_REFUSED' USING ERRCODE='55000';END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=s.table_id;
 IF tour IS NOT NULL THEN
 IF tour IS DISTINCT FROM (s.request#>>'{p_hand_row,tournament_id}')::uuid
 OR NOT EXISTS(SELECT FROM public.engine_tournament_leases l WHERE tournament_id=tour AND instance_id=NEW.instance_id AND lease_generation=NEW.lease_generation AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()))
 THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_LEASE_REFUSED' USING ERRCODE='55000';END IF;
 ELSE
  IF s.request#>>'{p_hand_row,tournament_id}' IS NOT NULL OR proof->>'scope' IS DISTINCT FROM 'cash'
  OR proof->>'source_cause' IS DISTINCT FROM 'backup_residue_constraint'
  OR smarter_private.cash_original17_fixed_sources_match() IS DISTINCT FROM true
  OR NOT EXISTS(SELECT FROM public.engine_table_leases l WHERE l.table_id=s.table_id
   AND l.instance_id=NEW.instance_id AND l.lease_generation=NEW.lease_generation
   AND l.protocol_version=2 AND l.heartbeat_at>=clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()))
  THEN RAISE EXCEPTION 'HAND_SOURCE_CORRECTION_LEASE_REFUSED' USING ERRCODE='55000';END IF;
 END IF;
 RETURN NEW;
END $body$;
ALTER FUNCTION smarter_private.original_tournament30_source_correction_proof(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_tournament30_source_correction_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.cash_original17_source_correction_proof(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.cash_original17_source_correction_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.cash_original17_fixed_sources_match() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.cash_original17_fixed_sources_match() FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.original_hand_source_correction_proof(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_hand_source_correction_proof(uuid) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION smarter_private.hand_source_correction_claim_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.hand_source_correction_claim_guard() FROM PUBLIC,anon,authenticated,service_role;
