-- Literal received original. No historical hand/table/recipient is manufactured.
CREATE TABLE cash_qualification.original_40538(inbox_id bigint PRIMARY KEY,original jsonb NOT NULL);
INSERT INTO cash_qualification.original_40538 VALUES(40538,$original${
  "id": 40538,
  "source": "financial-alerts-backfill",
  "event_key": "33f6a110-4591-4ce7-a249-6311e0584f9b",
  "status": "firing",
  "investigation_status": "new",
  "payload_md5": "fc1b3ce6b6ff24be9cf521c564630f61",
  "payload": {
    "captured_at": "2026-09-15T01:55:30.930303+00:00",
    "scope_basis": "Exact unresolved financial contributor to received MoneyAlertBacklogGrowing2935 aggregate; predates original seven-day discovery cutoff; not unrelated history import",
    "original_event": {
      "id": "33f6a110-4591-4ce7-a249-6311e0584f9b",
      "source": "fn_cash_pot_conservation_check",
      "context": {
        "kind": "no_winner_recorded",
        "chips": 600,
        "hands": 1,
        "detail": "a hand whose whole pot goes to the jackpot has no winner and owes nobody; this counts only the ones still holding chips",
        "channel": "server_rpc",
        "dedupe_key": "no_winner_recorded",
        "since_hours": 24
      },
      "message": "1 cash hand(s) in the last 24h recorded no winner at all while still holding 600.00 chips after rake and jackpot",
      "resolved": false,
      "severity": "warning",
      "created_at": "2026-09-06T14:34:00.384087+00:00",
      "resolution": null,
      "resolved_at": null,
      "resolved_by": null
    },
    "triggering_inbox_id": 40436,
    "backfill_window_start": "2026-09-06T16:30:00Z"
  }
}$original$::jsonb);
SELECT cash_qualification.assert_true(
  (SELECT md5((original->'payload')::text)='fc1b3ce6b6ff24be9cf521c564630f61'
    AND original#>>'{payload,original_event,id}'='33f6a110-4591-4ce7-a249-6311e0584f9b'
    AND original#>>'{payload,original_event,context,chips}'='600'
    AND NOT ((original#>'{payload,original_event,context}') ?| ARRAY['hand_id','table_id','hand_number'])
  FROM cash_qualification.original_40538),'literal 40538 identity and missing historical attribution');
INSERT INTO public.financial_alerts
SELECT f.* FROM cash_qualification.original_40538 o,
  LATERAL jsonb_populate_record(NULL::public.financial_alerts,o.original#>'{payload,original_event}') f;
