-- UNRUN native pure-evidence tests. Run only in the existing protected
-- accounting PostgreSQL allocation after the evidence component. No financial
-- table inserts, business functions, paid fixture or production identities.
BEGIN;
SET LOCAL statement_timeout='10s';
DO $test$
DECLARE sample jsonb := $sample${
  "version": 1,
  "tournament": {
    "id": "10000000-0000-4000-8000-000000000001",
    "status": "RUNNING",
    "variant": "spin",
    "tournament_type": "SNG",
    "satellite_target_id": null,
    "satellite_target": null,
    "is_bounty": false,
    "is_pko": false,
    "is_mystery_bounty": false,
    "starting_chips": 100
  },
  "observed_winner_id": "00000000-0000-4000-8000-000000000003",
  "tables": [
    {
      "id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001"
    }
  ],
  "roster": [
    {
      "id": "30000000-0000-4000-8000-000000000001",
      "user_id": "00000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 0,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "eliminated",
      "position": 3,
      "elimination_sequence": null
    },
    {
      "id": "30000000-0000-4000-8000-000000000002",
      "user_id": "00000000-0000-4000-8000-000000000002",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 0,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "eliminated",
      "position": 2,
      "elimination_sequence": 7
    },
    {
      "id": "30000000-0000-4000-8000-000000000003",
      "user_id": "00000000-0000-4000-8000-000000000003",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "chips": 300,
      "rebuys": 0,
      "add_on": false,
      "terminal_closed_at": null,
      "status": "playing",
      "position": null,
      "elimination_sequence": null
    }
  ],
  "receipts": [
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_id": "40000000-0000-4000-8000-000000000001",
      "status": "succeeded",
      "error": null,
      "completed_at": "2026-09-01T00:00:01+00:00",
      "result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000001",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000001,
        "players": 3,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000001",
              "stack_before": 100,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 100,
              "stack": 200
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 100
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000001": 0,
          "00000000-0000-4000-8000-000000000002": 200,
          "00000000-0000-4000-8000-000000000003": 100
        }
      }
    },
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_id": "40000000-0000-4000-8000-000000000002",
      "status": "succeeded",
      "error": null,
      "completed_at": "2026-09-01T00:00:02+00:00",
      "result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000002",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000002,
        "players": 2,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 200,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 300
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000002": 0,
          "00000000-0000-4000-8000-000000000003": 300
        }
      }
    }
  ],
  "histories": [
    {
      "id": "50000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "hand_number": 1000001,
      "players": [
        {
          "userId": "00000000-0000-4000-8000-000000000001",
          "stack": 0
        },
        {
          "userId": "00000000-0000-4000-8000-000000000002",
          "stack": 200
        },
        {
          "userId": "00000000-0000-4000-8000-000000000003",
          "stack": 100
        }
      ]
    },
    {
      "id": "50000000-0000-4000-8000-000000000002",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "hand_number": 1000002,
      "players": [
        {
          "userId": "00000000-0000-4000-8000-000000000002",
          "stack": 0
        },
        {
          "userId": "00000000-0000-4000-8000-000000000003",
          "stack": 300
        }
      ]
    }
  ],
  "commits": [
    {
      "table_id": "20000000-0000-4000-8000-000000000001",
      "hand_number": 1000002,
      "hand_id": "50000000-0000-4000-8000-000000000002",
      "stack_result": {
        "success": true,
        "conservation_checked": true,
        "hand_id": "40000000-0000-4000-8000-000000000002",
        "table_id": "20000000-0000-4000-8000-000000000001",
        "hand_number": 1000002,
        "players": 2,
        "rake": 0,
        "bbj": 0,
        "inflow": 0,
        "net_deltas": 0,
        "request": {
          "rake": 0,
          "bbj": 0,
          "inflow": 0,
          "stacks": [
            {
              "user_id": "00000000-0000-4000-8000-000000000002",
              "stack_before": 200,
              "stack": 0
            },
            {
              "user_id": "00000000-0000-4000-8000-000000000003",
              "stack_before": 100,
              "stack": 300
            }
          ]
        },
        "written": {
          "00000000-0000-4000-8000-000000000002": 0,
          "00000000-0000-4000-8000-000000000003": 300
        }
      },
      "committed_at": "2026-09-01T00:00:03+00:00",
      "post_commit_completed_at": "2026-09-01T00:00:04+00:00",
      "post_commit_payload": {
        "time_banks": []
      },
      "post_commit_payload_hash": "filled by native JSONB digest below",
      "post_commit_result": {
        "ok": true,
        "hand_id": "50000000-0000-4000-8000-000000000002",
        "hand_number": 1000002
      }
    }
  ],
  "knockouts": [
    {
      "id": "60000000-0000-4000-8000-000000000001",
      "tournament_id": "10000000-0000-4000-8000-000000000001",
      "table_id": "20000000-0000-4000-8000-000000000001",
      "eliminated_user_id": "00000000-0000-4000-8000-000000000002",
      "hand_id": "50000000-0000-4000-8000-000000000002",
      "hand_number": 1000002,
      "stack_before": 200,
      "stack_after": 0,
      "state": "eliminated"
    }
  ]
}$sample$::jsonb;
 original jsonb; changed jsonb; result jsonb; item record; tested integer:=0;
BEGIN
 sample:=jsonb_set(sample,'{commits,0,post_commit_payload_hash}',
   to_jsonb(encode(extensions.digest((sample#>'{commits,0,post_commit_payload}')::text,'sha256'),'hex')));
 original:=sample;
 result:=public.fn_ca_spin_mixed_history_shape_v1(sample);
 IF result->'shape_ok' IS DISTINCT FROM 'true'::jsonb
    OR result->'payment_authority' IS DISTINCT FROM 'false'::jsonb
    OR result->'historical_immutability_proven' IS DISTINCT FROM 'false'::jsonb
    OR result#>>'{legacy_zero,settlement_hand_id}'=result#>>'{legacy_zero,history_hand_id}'
    OR sample IS DISTINCT FROM original THEN
   RAISE EXCEPTION 'mixed shape positive/identity/non-authority control failed: %',result;
 END IF;
 FOR item IN SELECT * FROM (VALUES
  ('failed_receipt',ARRAY['receipts','0','status'],'"failed"'::jsonb),
  ('false_success',ARRAY['receipts','0','result','success'],'false'::jsonb),
  ('false_conservation',ARRAY['receipts','0','result','conservation_checked'],'false'::jsonb),
  ('foreign_result_hand',ARRAY['receipts','0','result','hand_id'],'"40000000-0000-4000-8000-000000000009"'::jsonb),
  ('missing_old_sequence_field',ARRAY['roster','0','elimination_sequence'],'"unknown"'::jsonb),
  ('already_sequenced_old_bust',ARRAY['roster','0','elimination_sequence'],'6'::jsonb),
  ('missing_modern_sequence',ARRAY['roster','1','elimination_sequence'],'null'::jsonb),
  ('changed_existing_place',ARRAY['roster','0','position'],'2'::jsonb),
  ('changed_current_stack',ARRAY['roster','2','chips'],'301'::jsonb),
  ('foreign_history_user',ARRAY['histories','0','players','0','userId'],'"00000000-0000-4000-8000-000000000009"'::jsonb),
  ('duplicate_history_number',ARRAY['histories','1','hand_number'],'1000001'::jsonb),
  ('pending_postcommit',ARRAY['commits','0','post_commit_completed_at'],'null'::jsonb),
  ('wrong_canonical_completion_uuid',ARRAY['commits','0','post_commit_result','hand_id'],'"40000000-0000-4000-8000-000000000002"'::jsonb),
  ('changed_stored_envelope',ARRAY['commits','0','post_commit_payload','time_banks'],'[{}]'::jsonb),
  ('no_modern_commit',ARRAY['commits'],'[]'::jsonb),
  ('foreign_knockout',ARRAY['knockouts','0','eliminated_user_id'],'"00000000-0000-4000-8000-000000000001"'::jsonb),
  ('late_entry_count',ARRAY['roster','0','rebuys'],'1'::jsonb),
  ('two_tables',ARRAY['tables'],'[]'::jsonb),
  ('missing_receipt',ARRAY['receipts'],'[]'::jsonb),
  ('invalid_date',ARRAY['receipts','0','completed_at'],'"today"'::jsonb)
 ) cases(name,path,replacement) LOOP
  changed:=jsonb_set(sample,item.path,item.replacement);
  result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
  IF result->'shape_ok' IS DISTINCT FROM 'false'::jsonb OR result->>'reason' IS NULL THEN
   RAISE EXCEPTION 'mixed shape negative % falsely passed: %',item.name,result;
  END IF;
  tested:=tested+1;
 END LOOP;
 -- Conservation alone is insufficient: before-stacks may conserve the total
 -- while disagreeing with the preceding exact accepted after-stacks.
 changed:=jsonb_set(jsonb_set(sample,'{receipts,1,result,request,stacks,0,stack_before}','199'),
   '{receipts,1,result,request,stacks,1,stack_before}','101');
 changed:=jsonb_set(changed,'{commits,0,stack_result}',changed#>'{receipts,1,result}');
 result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
 IF result->>'reason' IS DISTINCT FROM 'stack_continuity_or_history' THEN
  RAISE EXCEPTION 'mixed conserved-but-discontinuous stack control failed: %',result;
 END IF;
 -- Both relative values used to pass finite/order checks at transaction time.
 -- One changed field alone could fail the ordering check and miss this defect.
 changed:=jsonb_set(jsonb_set(sample,'{commits,0,committed_at}','"now"'::jsonb),
   '{commits,0,post_commit_completed_at}','"now"'::jsonb);
 result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
 IF result->'shape_ok'='true'::jsonb THEN
  RAISE EXCEPTION 'mixed shape accepted relative modern commit timestamps' USING ERRCODE='PZ020';
 END IF;
 IF result->'shape_ok' IS DISTINCT FROM 'false'::jsonb
    OR result->>'reason' IS DISTINCT FROM 'modern_commit_or_required_completion' THEN
  RAISE EXCEPTION 'mixed shape relative timestamp control wrong refusal: %',result;
 END IF;
 -- Isolate both format checks with a finite absolute alias and valid ordering.
 -- Either missing regex must fail independently of the other field's guard.
 FOR item IN SELECT * FROM (VALUES
  ('committed_at','epoch','2026-09-15T00:00:01Z'),
  ('post_commit_completed_at','1969-12-31T23:59:59Z','epoch')
 ) cases(name,committed,completed) LOOP
  changed:=jsonb_set(jsonb_set(sample,'{commits,0,committed_at}',to_jsonb(item.committed)),
    '{commits,0,post_commit_completed_at}',to_jsonb(item.completed));
  result:=public.fn_ca_spin_mixed_history_shape_v1(changed);
  IF result->'shape_ok' IS DISTINCT FROM 'false'::jsonb
     OR result->>'reason' IS DISTINCT FROM 'modern_commit_or_required_completion' THEN
   RAISE EXCEPTION 'mixed shape relative % control wrong refusal: %',item.name,result;
  END IF;
 END LOOP;
 IF tested<>20 OR EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) role_name
     WHERE has_function_privilege(role_name,'public.fn_ca_spin_mixed_history_shape_v1(jsonb)','EXECUTE')
        OR has_function_privilege(role_name,'public.fn_ca_accepted_tournament_settlement_fact(jsonb)','EXECUTE')) THEN
  RAISE EXCEPTION 'mixed shape control count/private execute boundary failed';
 END IF;
 RAISE NOTICE 'mixed shape: one positive and 24 negative native controls passed; no financial qualification';
END;
$test$;
ROLLBACK;
