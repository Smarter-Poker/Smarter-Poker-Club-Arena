# Commercial State Diagrams

R2 line 1699 asks for a "commercial state diagram and real source/function/table/permission map". The source, function, table and permission map is `c1-wiring-map.md`. The diagrams below cover the eight commercial records: trial, quote, purchase, entitlement, renewal mandate, refund request, price version and notice.

Every transition is labelled with the function that performs it and a `file:line` reference. Short names follow `c1-wiring-map.md`:

| Short name | File             |
| ---------- | ---------------- |
| M1         | `20260922143541` |
| M2         | `20260924033509` |
| M3         | `20260924102040` |
| M4         | `20260924102056` |

States written in _italics_ in the notes are **derived from time** and have no column value. Each diagram draws only transitions that code performs. If a state has no outgoing edge, no code moves a row out of it.

## 1. Trial (`ca_commerce_trials`, `ca_commerce_trial_scopes`)

A trial row is never updated after insert. No function in M1 to M4 updates or deletes `ca_commerce_trials`. Its phase comes from `trial_start` and `trial_end` alone, compared with `now()` (M1:540-544).

```mermaid
stateDiagram-v2
    [*] --> Scheduled: fn_ca_commerce_activate_launch_cohort(p_effective_at in future) M1:741 / M3:1072
    [*] --> Active: fn_ca_commerce_activate_trial (owner) M1:725 -> _impl M1:651, start = now()
    Scheduled --> Active: now() >= trial_start (derived)
    Active --> Active: another scope of the same operator enrolls, end unchanged M1:689-694
    Active --> Ended: now() >= trial_end = trial_start + 720h M1:684 (derived)
    Ended --> Ended: activation replay returns the existing trial M1:675-679
    note right of Active
        One row per operator_id (UNIQUE M1:170).
        A trial_operating entitlement with net_paid 0 is written per scope (M1:699-700).
        Purchases with net > 0 are refused while Active (M2:562-564).
        Admission answers 'trial' (M4:185-186).
    end note
```

## 2. Quote (`ca_commerce_quotes.status`, CHECK M1:240)

```mermaid
stateDiagram-v2
    [*] --> open: fn_ca_commerce_quote -> _impl M2:419-423 (expires_at = now + 15 min, M1:68)
    open --> consumed: fn_ca_commerce_purchase_impl commits, purchase_id set M2:703
    open --> expired: a purchase attempt after expires_at M2:523-527
    open --> withdrawn: context hash changed M2:552-554
    open --> withdrawn: period already covered M2:600-603
    open --> withdrawn: renewal system quote not used M2:866, M2:884
    consumed --> consumed: a replay of the same quote returns the same purchase M2:519-522
    note right of open
        'expired' is written lazily. A quote past expires_at that is
        never submitted stays 'open' in the table.
        CHECK: consumed exactly when purchase_id is set (M1:245).
    end note
```

## 3. Purchase (`ca_commerce_purchases`)

A purchase has no status column. The row is written once and is append-only: the trigger `ca_commerce_purchases_append_only` (M1:435-436) refuses every UPDATE and DELETE. Every state the receipt reports is derived.

```mermaid
stateDiagram-v2
    [*] --> Committed: fn_ca_commerce_purchase_impl M2:663-667 (with debit, journal, Mint and lot proofs M2:618-654, or net = 0)
    [*] --> NotCommitted: any refusal or unproved postcondition rolls back the transaction M1:1409-1426
    Committed --> Committed: a replay by request key M2:500-508 or quote M2:519-522 returns the receipt with charged_this_attempt = 0 M2:444
    NotCommitted --> [*]
    note right of Committed
        entitlement_status in the receipt is derived from its rights:
        effective, superseded, revoked or mixed (M2:455-456).
        delivery_status is always 'delivered' (M2:452): no
        asynchronous fulfillment exists.
    end note
```

## 4. Entitlement (`ca_commerce_entitlements.state`, CHECK M1:297)

```mermaid
stateDiagram-v2
    [*] --> effective: trial right M1:699-700
    [*] --> effective: purchase line M2:679-685 (source purchase or sponsor)
    state effective {
        [*] --> Scheduled
        Scheduled --> InForce: now() >= starts_at (derived)
        InForce --> PastEnd: now() >= ends_at (derived; row stays 'effective')
    }
    effective --> superseded: an upgrade replaces it; ends_at is set to the switch instant M2:689
    effective --> revoked: a full refund of its line M2:1088-1089
    note right of superseded
        superseded_by points to the new right (revision + 1).
        The value it carries forward is value_basis = net + credit (M2:683).
    end note
```

## 5. Renewal mandate (`ca_commerce_renewal_mandates.state`, CHECK M1:332; one per right M2:97-98)

```mermaid
stateDiagram-v2
    [*] --> authorized: fn_ca_commerce_set_renewal(enabled) M2:769-772 / M3:817-822
    [*] --> authorized: purchase with renewal_max_diamonds M2:694-699
    [*] --> authorized: carried forward after a renewal M2:897-903 / M3:970-976
    authorized --> authorized: claim sets lease_token, lease_until +2 min M3:724-727
    authorized --> authorized: an upgrade moves it to the new right M2:690-692
    authorized --> completed: execute renewed M2:895-896
    authorized --> needs_attention: execute not renewed M2:904-912
    authorized --> cancelled: fn_ca_commerce_set_renewal(disabled) M2:788-789
    authorized --> cancelled: a full refund of its right M2:1090
    needs_attention --> authorized: re-authorized M2:776-779 / M3:826-830
    cancelled --> authorized: re-authorized M2:776-779 / M3:826-830
    completed --> completed: set_renewal refuses period_already_renewed M2:773-774
    note right of needs_attention
        Reasons (M2:839-889, M3:907-959):
        payer_no_longer_owner_or_right_changed,
        lapsed_beyond_lateness_policy (more than 24h late, M1:70),
        no_published_price, price_above_accepted_ceiling,
        period_already_covered, insufficient_diamonds, reserved_diamonds,
        sponsorship_* (M3), and any CA_COMMERCE_* postcondition.
        One notice per failed attempt (M2:908).
    end note
```

## 6. Refund request (`ca_commerce_refund_requests.state`, M3:184-219, **pending install**)

The executed refund itself is a separate append-only row in `ca_commerce_refunds` (M1:349, trigger M1:437). A staff service-route call to the core `fn_ca_commerce_refund` (M2:958) can also create that row without any request.

```mermaid
stateDiagram-v2
    [*] --> requested: fn_ca_commerce_refund_request (payer only) M3:456-461
    requested --> approved: fn_ca_commerce_refund_decide(approve) by staff who are not the payer M3:527-529
    requested --> declined: fn_ca_commerce_refund_decide(decline, note) M3:538-540
    approved --> refunded: consumer executes the core M3:633-637
    approved --> owed: retryable refusal (for example wallet headroom) M3:643-653
    owed --> owed: retried on each wake, notified once M3:654-662
    owed --> refunded: M3:633-637
    approved --> failed: non-retryable refusal M3:665-672
    owed --> failed: M3:665-672
    note right of requested
        One open request per purchase line: UNIQUE WHERE state in
        (requested, approved, owed) (M3:220-221).
        The policy amount is computed server-side at request time (M3:452-460).
    end note
```

## 7. Price version (`ca_commerce_price_versions.status`, trigger M1:123-158)

The trigger allows only these moves:

- draft to validated or retired
- validated to published or retired
- published to retired

A published or retired row can never change its price fields.

```mermaid
stateDiagram-v2
    [*] --> draft: fn_ca_commerce_price_draft M3:1156-1157
    [*] --> validated: installed M1 draft door wrote 'validated' directly M1:1928-1929 (replaced by M3)
    draft --> validated: fn_ca_commerce_price_validate M3:1203
    draft --> retired: fn_ca_commerce_price_retire M3:1320
    validated --> published: fn_ca_commerce_price_publish M2:1153 / M3:1252
    validated --> retired: fn_ca_commerce_price_retire M3:1320
    published --> retired: a successor published now, or a later-dated version replaced M2:1149-1152 / M3:1248-1251
    published --> retired: fn_ca_commerce_price_retire with effective_to <= now M3:1313-1317
    published --> published: a prospective retirement or successor sets effective_to (still 'published') M3:1310-1312
    note right of published
        Catalog v1 installs nine rows as published and seven as
        validated (M1:464-480). A published row whose effective_to
        has passed stays 'published'; every reader filters by
        effective_from and effective_to (M1:796, M2:285-286).
    end note
```

## 8. Notice (`ca_commerce_notices`, dedupe key UNIQUE M1:388)

```mermaid
stateDiagram-v2
    [*] --> delivered: fn_ca_commerce_notice with due_at <= now, inserted into notifications in the same transaction M1:639-644
    [*] --> pending: fn_ca_commerce_notice with a future due_at M1:632-635
    [*] --> pending: the 72-hour funds trigger on an authorized mandate M3:263-282
    [*] --> Deduplicated: a duplicate dedupe_key inserts nothing and returns the existing id M1:634-638
    Deduplicated --> [*]
    pending --> delivered: fn_ca_commerce_deliver_due_notices (Engine) M3:1058-1061
    pending --> suppressed: funds check finds enough balance, or the mandate is no longer due, or no price M3:1049-1054
    note right of pending
        Delivery means a row in public.notifications, not device receipt (D27).
        pending means delivered_at IS NULL AND suppressed_at IS NULL
        (index M3:178). 'suppressed' exists only after M3 is installed.
    end note
```
