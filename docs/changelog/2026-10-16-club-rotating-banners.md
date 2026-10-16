# Club Rotating Banners

Banner Displays now lets actual club owners upload, title, order, enable, disable and remove up to three lobby-strip banners, including union clubs. The top club banner remains independently editable.

The existing owner-only clubs RLS authorizes writes. Full-settings compare-and-swap preserves unrelated settings and rejects concurrent edits; lost responses recover from durable state. Images are restricted to the configured storage origin and this club's immutable upload namespace. No migration or engine change is required.

Enabled club banners take priority in the existing three-image rotator and fullscreen preview. Resolver-selected platform promotions fill unused slots, and remain the fallback when no club banner is enabled. They never produce paid-ad events. Disabled banners are excluded, broken images leave rotation, and route changes discard stale requests.

Regression coverage includes storage validation, owner/CAS/refusal/recovery, the real editor, shared rotator and isolated production upload, order, toggle, reload, lobby readback, removal and cleanup.
