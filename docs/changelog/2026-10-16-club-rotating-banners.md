# Club Rotating Banners

Banner Displays now lets actual club owners upload, title, order, enable, disable and remove up to three lobby-strip banners, including union clubs. The top club banner remains independently editable.

The existing owner-only clubs RLS authorizes writes. Full-settings compare-and-swap preserves unrelated settings and rejects concurrent edits; lost responses recover from durable state. Images are restricted to the configured storage origin and this club's immutable upload namespace. No migration or engine change is required.

Club banners join eligible resolver-selected advertising in the existing responsive rotator and fullscreen preview. They never produce paid-ad events. Disabled banners are excluded, broken images leave rotation, and route changes discard stale requests.

Regression coverage includes storage validation, owner/CAS/refusal/recovery, the real editor, shared rotator and isolated production upload, order, toggle, reload, lobby readback, removal and cleanup.
