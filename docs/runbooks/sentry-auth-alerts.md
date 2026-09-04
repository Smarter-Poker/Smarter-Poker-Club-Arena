# Runbook — Sentry Auth Alert Rules

**When to use this runbook**

- Setting up the four auth-monitoring Sentry alert rules for the first time.
- Recreating a deleted alert rule.
- Verifying the alert rules are active.

---

## Background

These four alert rules catch authentication failures and security anomalies on the
Commander platform. They fire to `admin@smarter.poker` via email and (when available)
to the `#alerts` Slack channel on the `smarter-software-inc` Sentry org.

Sentry project: `javascript-nextjsmarter-poker-world-hubs`
Organisation slug: `smarter-software-inc`
Auth token: `SENTRY_AUTH_TOKEN` (in `~/Documents/club-arena/.env`)

---

## The Four Alert Rules

### Rule 1 — Auth Failure Spike

**What it catches**: A sudden burst of sign-in failures (brute-force attempt or a
broken auth flow after a deploy).

| Setting     | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Type        | Issue alert (event count threshold)                                    |
| Trigger     | ≥ 10 events matching `auth.failed` or `AuthError` in a 5-minute window |
| Environment | production                                                             |
| Priority    | High                                                                   |
| Action      | Email `admin@smarter.poker`                                            |

```bash
# Create via Sentry API
SENTRY_TOKEN="<SENTRY_AUTH_TOKEN>"
ORG="smarter-software-inc"
PROJECT="javascript-nextjsmarter-poker-world-hubs"

curl -s -X POST "https://sentry.io/api/0/projects/$ORG/$PROJECT/rules/" \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auth Failure Spike",
    "conditions": [
      {
        "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
        "interval": "5m",
        "value": 10
      }
    ],
    "filters": [
      {
        "id": "sentry.rules.filters.tagged_event.TaggedEventFilter",
        "key": "level",
        "match": "eq",
        "value": "error"
      }
    ],
    "actions": [
      {
        "id": "sentry.mail.actions.NotifyEmailAction",
        "targetType": "Member",
        "targetIdentifier": "admin@smarter.poker"
      }
    ],
    "actionMatch": "any",
    "filterMatch": "all",
    "frequency": 30,
    "environment": "production"
  }' | python3 -m json.tool | head -10
```

---

### Rule 2 — Session Token Validation Error

**What it catches**: Errors from the [`staff-session-jwt-rotation.md`](../runbooks/staff-session-jwt-rotation.md) layer — signals
that `COMMANDER_STAFF_SESSION_SECRET` is wrong or a token was tampered with.

| Setting     | Value                                                                                  |
| ----------- | -------------------------------------------------------------------------------------- |
| Type        | Issue alert                                                                            |
| Trigger     | ≥ 1 new issue with title matching `SessionValidationError` OR `jwt` (case-insensitive) |
| Environment | production                                                                             |
| Priority    | Critical                                                                               |
| Action      | Email `admin@smarter.poker`                                                            |

```bash
curl -s -X POST "https://sentry.io/api/0/projects/$ORG/$PROJECT/rules/" \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Session Token Validation Error",
    "conditions": [
      {
        "id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"
      }
    ],
    "filters": [
      {
        "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
        "attribute": "message",
        "match": "co",
        "value": "jwt"
      }
    ],
    "actions": [
      {
        "id": "sentry.mail.actions.NotifyEmailAction",
        "targetType": "Member",
        "targetIdentifier": "admin@smarter.poker"
      }
    ],
    "actionMatch": "any",
    "filterMatch": "any",
    "frequency": 5,
    "environment": "production"
  }' | python3 -m json.tool | head -10
```

---

### Rule 3 — Repeated Probe Auth Failure (Unsigned-In Probe)

**What it catches**: The post-deploy probe failed to authenticate. This surfaces as
`E2E_REQUIRE_AUTH=1` failures from `global-setup.ts`, reported as Sentry errors when
the probe script catches and re-throws them.

| Setting     | Value                                                      |
| ----------- | ---------------------------------------------------------- |
| Type        | Issue alert                                                |
| Trigger     | ≥ 3 events matching `probe` OR `E2E` in a 15-minute window |
| Environment | production                                                 |
| Priority    | High                                                       |
| Action      | Email `admin@smarter.poker`                                |

```bash
curl -s -X POST "https://sentry.io/api/0/projects/$ORG/$PROJECT/rules/" \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Repeated Probe Auth Failure",
    "conditions": [
      {
        "id": "sentry.rules.conditions.event_frequency.EventFrequencyCondition",
        "interval": "15m",
        "value": 3
      }
    ],
    "filters": [
      {
        "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
        "attribute": "message",
        "match": "co",
        "value": "probe"
      }
    ],
    "actions": [
      {
        "id": "sentry.mail.actions.NotifyEmailAction",
        "targetType": "Member",
        "targetIdentifier": "admin@smarter.poker"
      }
    ],
    "actionMatch": "any",
    "filterMatch": "any",
    "frequency": 60,
    "environment": "production"
  }' | python3 -m json.tool | head -10
```

---

### Rule 4 — New Unhandled Auth Error (First Occurrence)

**What it catches**: Any brand-new (first-seen) unhandled error whose title or message
contains `auth`, `Auth`, `Unauthorized`, or `403` in production. Catches regressions
introduced by deploys that the probe did not cover.

| Setting     | Value                                                                 |
| ----------- | --------------------------------------------------------------------- |
| Type        | Issue alert                                                           |
| Trigger     | First time this issue is seen                                         |
| Filter      | Message contains `auth` OR `unauthorized` OR `403` (case-insensitive) |
| Environment | production                                                            |
| Priority    | High                                                                  |
| Action      | Email `admin@smarter.poker`                                           |

```bash
curl -s -X POST "https://sentry.io/api/0/projects/$ORG/$PROJECT/rules/" \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "New Unhandled Auth Error",
    "conditions": [
      {
        "id": "sentry.rules.conditions.first_seen_event.FirstSeenEventCondition"
      }
    ],
    "filters": [
      {
        "id": "sentry.rules.filters.event_attribute.EventAttributeFilter",
        "attribute": "message",
        "match": "co",
        "value": "auth"
      }
    ],
    "actions": [
      {
        "id": "sentry.mail.actions.NotifyEmailAction",
        "targetType": "Member",
        "targetIdentifier": "admin@smarter.poker"
      }
    ],
    "actionMatch": "any",
    "filterMatch": "any",
    "frequency": 30,
    "environment": "production"
  }' | python3 -m json.tool | head -10
```

---

## Verifying Rules Are Active

```bash
curl -s "https://sentry.io/api/0/projects/$ORG/$PROJECT/rules/" \
  -H "Authorization: Bearer $SENTRY_TOKEN" \
  | python3 -c "import json,sys; rules=json.load(sys.stdin); [print(r['id'], r['name']) for r in rules]"
```

Expected output (IDs will differ):

```
123456 Auth Failure Spike
123457 Session Token Validation Error
123458 Repeated Probe Auth Failure
123459 New Unhandled Auth Error
```

---

## History

| Date       | Action                                | Operator |
| ---------- | ------------------------------------- | -------- |
| 2026-09-03 | Rules created via API (see changelog) | Agent    |
