// Captured from the actual terminal core, marker and receipt verifier in the
// isolated tournament-fee native fixture. Prize amount is deliberately zero;
// fee bank and source recognition are proven independently of prize payers.
export const accountingTerminalReceipts = [
  {
    "ok": true,
    "cash": {
      "ok": true,
      "status": "COMPLETING",
      "payouts": [
        {
          "place": 1,
          "amount": 0,
          "user_id": "00000000-0000-0000-0000-000000005011"
        }
      ],
      "deal_shares": [],
      "fully_settled": true,
      "winner_amount": 0.0,
      "bubble_protection": null
    },
    "mode": "places",
    "rake": {
      "amount": 1.0,
      "accounting": {
        "reason": null,
        "status": "recognized",
        "payable": true,
        "banked_at": "2026-09-14T09:26:40.633842-05:00",
        "bank_amount": 1,
        "bank_club_id": "00000000-0000-0000-0000-000000000099",
        "bank_union_id": "00000000-0000-0000-0000-000000000090",
        "tournament_id": "00000000-0000-0000-0000-000000005000",
        "bank_receipt_id": "fee69261-2d00-4024-b557-bb4db068446c",
        "bank_receipt_kind": "union_wallet_transaction",
        "accounting_version": 2,
        "source_fingerprint": "38eeec281530526b6ba40193c898ff2a",
        "recognized_source_count": 1
      },
      "attributed": true,
      "settled_at": "2026-09-14T09:26:40.633842-05:00",
      "destination": "union:00000000-0000-0000-0000-000000000090",
      "attributed_at": "2026-09-14T09:26:40.633842-05:00",
      "attributed_users": 1
    },
    "bounty": {
      "ok": true,
      "funded": true,
      "reason": "not_a_bounty_tournament",
      "residual": 0
    },
    "escrow": {
      "closed_at": "2026-09-14T09:26:40.633842-05:00",
      "close_note": "terminal receipt: exact zero",
      "fee_balance": 0.0,
      "prize_balance": 0.0,
      "bounty_balance": 0.0
    },
    "status": "COMPLETED",
    "payouts": [
      {
        "place": 1,
        "amount": 0,
        "user_id": "00000000-0000-0000-0000-000000005011"
      }
    ],
    "winner_id": "00000000-0000-0000-0000-000000005011",
    "settled_at": "2026-09-14T09:26:40.633842-05:00",
    "deal_shares": [],
    "fully_settled": true,
    "table_closure": {
      "source_seat_ids": [
        "00000000-0000-0000-0000-000000005071"
      ],
      "closed_table_ids": [
        "00000000-0000-0000-0000-000000005070"
      ],
      "released_seat_ids": [
        "00000000-0000-0000-0000-000000005071"
      ],
      "source_seat_count": 1,
      "closed_table_count": 1,
      "released_seat_count": 1
    },
    "tournament_id": "00000000-0000-0000-0000-000000005000",
    "winner_amount": 0.0,
    "mystery_bounty": {
      "ok": true,
      "reason": "not_a_mystery_tournament",
      "balanced": true,
      "pool_cents": 0,
      "settled_cents": 0,
      "variance_cents": 0,
      "unclaimed_cents": 0,
      "residual_paid_cents": 0
    },
    "receipt_version": 2,
    "settlement_mode": "places",
    "bubble_protection": null,
    "cash_payout_total": 0.0,
    "source_seat_count": 1,
    "closed_table_count": 1,
    "bounty_payout_total": 0.0,
    "released_seat_count": 1
  },
  {
    "ok": true,
    "cash": {
      "ok": true,
      "status": "COMPLETING",
      "payouts": [
        {
          "place": 1,
          "amount": 0,
          "user_id": "00000000-0000-0000-0000-000000005111"
        }
      ],
      "deal_shares": [],
      "fully_settled": true,
      "winner_amount": 0.0,
      "bubble_protection": null
    },
    "mode": "places",
    "rake": {
      "amount": 1.0,
      "accounting": {
        "reason": "tournament_fee_sources_require_reconciliation",
        "status": "banked_accrual_deferred",
        "payable": false,
        "banked_at": "2026-09-14T09:26:40.633842-05:00",
        "bank_amount": 1,
        "bank_club_id": "00000000-0000-0000-0000-000000000099",
        "bank_union_id": "00000000-0000-0000-0000-000000000090",
        "tournament_id": "00000000-0000-0000-0000-000000005100",
        "bank_receipt_id": "83ca2995-676f-48c6-a64d-a996b9f7daa5",
        "bank_receipt_kind": "union_wallet_transaction",
        "accounting_version": 2,
        "source_fingerprint": "517caefafcbe188bd35f6110f539a048",
        "recognized_source_count": 0
      },
      "attributed": false,
      "settled_at": "2026-09-14T09:26:40.633842-05:00",
      "destination": "union:00000000-0000-0000-0000-000000000090",
      "attributed_at": null,
      "attributed_users": 0
    },
    "bounty": {
      "ok": true,
      "funded": true,
      "reason": "not_a_bounty_tournament",
      "residual": 0
    },
    "escrow": {
      "closed_at": "2026-09-14T09:26:40.633842-05:00",
      "close_note": "terminal receipt: exact zero",
      "fee_balance": 0.0,
      "prize_balance": 0.0,
      "bounty_balance": 0.0
    },
    "status": "COMPLETED",
    "payouts": [
      {
        "place": 1,
        "amount": 0,
        "user_id": "00000000-0000-0000-0000-000000005111"
      }
    ],
    "winner_id": "00000000-0000-0000-0000-000000005111",
    "settled_at": "2026-09-14T09:26:40.633842-05:00",
    "deal_shares": [],
    "fully_settled": true,
    "table_closure": {
      "source_seat_ids": [
        "00000000-0000-0000-0000-000000005171"
      ],
      "closed_table_ids": [
        "00000000-0000-0000-0000-000000005170"
      ],
      "released_seat_ids": [
        "00000000-0000-0000-0000-000000005171"
      ],
      "source_seat_count": 1,
      "closed_table_count": 1,
      "released_seat_count": 1
    },
    "tournament_id": "00000000-0000-0000-0000-000000005100",
    "winner_amount": 0.0,
    "mystery_bounty": {
      "ok": true,
      "reason": "not_a_mystery_tournament",
      "balanced": true,
      "pool_cents": 0,
      "settled_cents": 0,
      "variance_cents": 0,
      "unclaimed_cents": 0,
      "residual_paid_cents": 0
    },
    "receipt_version": 2,
    "settlement_mode": "places",
    "bubble_protection": null,
    "cash_payout_total": 0.0,
    "source_seat_count": 1,
    "closed_table_count": 1,
    "bounty_payout_total": 0.0,
    "released_seat_count": 1
  }
] as const;

// Full lifecycle receipts below use actual registration, satellite transfer,
// 180-chip prize payment, 20-chip fee banking and terminal verifier functions.
// Historical agreements and the final-hand scene are synthetic native inputs.
export const fullLifecycleTerminalReceipts = [
  {
    "ok": true,
    "cash": {
      "ok": true,
      "status": "COMPLETING",
      "payouts": [
        {
          "place": 1,
          "amount": 180.0,
          "user_id": "d1000000-0000-4000-8000-000000000002"
        }
      ],
      "deal_shares": [],
      "fully_settled": true,
      "winner_amount": 180.0,
      "bubble_protection": null
    },
    "mode": "places",
    "rake": {
      "amount": 20.0,
      "accounting": {
        "reason": null,
        "status": "recognized",
        "payable": true,
        "banked_at": "2026-09-14T10:06:05.429857-05:00",
        "bank_amount": 20.0,
        "bank_club_id": "d2000000-0000-4000-8000-000000000002",
        "bank_union_id": null,
        "tournament_id": "d3000000-0000-4000-8000-000000000002",
        "bank_receipt_id": "e2beac10-fdb6-4b33-877f-d339e413c5cc",
        "bank_receipt_kind": "chip_ledger",
        "accounting_version": 2,
        "source_fingerprint": "5d0cc3c2b901a09d5c525f02f5f241f6",
        "recognized_source_count": 2
      },
      "attributed": true,
      "settled_at": "2026-09-14T10:06:05.429857-05:00",
      "destination": "club_treasury:d2000000-0000-4000-8000-000000000002",
      "attributed_at": "2026-09-14T10:06:05.429857-05:00",
      "attributed_users": 2
    },
    "bounty": {
      "ok": true,
      "funded": true,
      "reason": "not_a_bounty_tournament",
      "residual": 0
    },
    "escrow": {
      "closed_at": "2026-09-14T10:06:05.429857-05:00",
      "close_note": "terminal receipt: exact zero",
      "fee_balance": 0.0,
      "prize_balance": 0.0,
      "bounty_balance": 0.0
    },
    "status": "COMPLETED",
    "payouts": [
      {
        "place": 1,
        "amount": 180.0,
        "user_id": "d1000000-0000-4000-8000-000000000002"
      }
    ],
    "winner_id": "d1000000-0000-4000-8000-000000000002",
    "settled_at": "2026-09-14T10:06:05.429857-05:00",
    "deal_shares": [],
    "fully_settled": true,
    "table_closure": {
      "source_seat_ids": [
        "d6000000-0000-4000-8000-000000000002"
      ],
      "closed_table_ids": [
        "d5000000-0000-4000-8000-000000000002"
      ],
      "released_seat_ids": [
        "d6000000-0000-4000-8000-000000000002"
      ],
      "source_seat_count": 1,
      "closed_table_count": 1,
      "released_seat_count": 1
    },
    "tournament_id": "d3000000-0000-4000-8000-000000000002",
    "winner_amount": 180.0,
    "mystery_bounty": {
      "ok": true,
      "reason": "not_a_mystery_tournament",
      "balanced": true,
      "pool_cents": 0,
      "settled_cents": 0,
      "variance_cents": 0,
      "unclaimed_cents": 0,
      "residual_paid_cents": 0
    },
    "receipt_version": 2,
    "settlement_mode": "places",
    "bubble_protection": null,
    "cash_payout_total": 180.0,
    "source_seat_count": 1,
    "closed_table_count": 1,
    "bounty_payout_total": 0.0,
    "released_seat_count": 1
  },
  {
    "ok": true,
    "cash": {
      "ok": true,
      "status": "COMPLETING",
      "payouts": [
        {
          "place": 1,
          "amount": 180.0,
          "user_id": "d1000000-0000-4000-8000-000000000002"
        }
      ],
      "deal_shares": [],
      "fully_settled": true,
      "winner_amount": 180.0,
      "bubble_protection": null
    },
    "mode": "places",
    "rake": {
      "amount": 20.0,
      "accounting": {
        "reason": "tournament_fee_sources_require_reconciliation",
        "status": "banked_accrual_deferred",
        "payable": false,
        "banked_at": "2026-09-14T10:06:05.816098-05:00",
        "bank_amount": 20.0,
        "bank_club_id": "d2000000-0000-4000-8000-000000000002",
        "bank_union_id": null,
        "tournament_id": "d3000000-0000-4000-8000-000000000002",
        "bank_receipt_id": "87869411-c242-40bd-ac77-c6a022c1b15d",
        "bank_receipt_kind": "chip_ledger",
        "accounting_version": 2,
        "source_fingerprint": "e0b7ca93eee7e6bd5477119037bbef6b",
        "recognized_source_count": 0
      },
      "attributed": false,
      "settled_at": "2026-09-14T10:06:05.816098-05:00",
      "destination": "club_treasury:d2000000-0000-4000-8000-000000000002",
      "attributed_at": null,
      "attributed_users": 0
    },
    "bounty": {
      "ok": true,
      "funded": true,
      "reason": "not_a_bounty_tournament",
      "residual": 0
    },
    "escrow": {
      "closed_at": "2026-09-14T10:06:05.816098-05:00",
      "close_note": "terminal receipt: exact zero",
      "fee_balance": 0.0,
      "prize_balance": 0.0,
      "bounty_balance": 0.0
    },
    "status": "COMPLETED",
    "payouts": [
      {
        "place": 1,
        "amount": 180.0,
        "user_id": "d1000000-0000-4000-8000-000000000002"
      }
    ],
    "winner_id": "d1000000-0000-4000-8000-000000000002",
    "settled_at": "2026-09-14T10:06:05.816098-05:00",
    "deal_shares": [],
    "fully_settled": true,
    "table_closure": {
      "source_seat_ids": [
        "d6000000-0000-4000-8000-000000000002"
      ],
      "closed_table_ids": [
        "d5000000-0000-4000-8000-000000000002"
      ],
      "released_seat_ids": [
        "d6000000-0000-4000-8000-000000000002"
      ],
      "source_seat_count": 1,
      "closed_table_count": 1,
      "released_seat_count": 1
    },
    "tournament_id": "d3000000-0000-4000-8000-000000000002",
    "winner_amount": 180.0,
    "mystery_bounty": {
      "ok": true,
      "reason": "not_a_mystery_tournament",
      "balanced": true,
      "pool_cents": 0,
      "settled_cents": 0,
      "variance_cents": 0,
      "unclaimed_cents": 0,
      "residual_paid_cents": 0
    },
    "receipt_version": 2,
    "settlement_mode": "places",
    "bubble_protection": null,
    "cash_payout_total": 180.0,
    "source_seat_count": 1,
    "closed_table_count": 1,
    "bounty_payout_total": 0.0,
    "released_seat_count": 1
  }
];
