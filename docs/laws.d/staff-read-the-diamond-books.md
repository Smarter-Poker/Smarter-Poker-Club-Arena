# tests/staff-read-the-diamond-books.law.test.ts

Platform staff read the Diamond books through one door, and only platform
staff. fn_ca_diamond_staff_books asks fn_is_platform_admin() before anything
else, refuses every other caller by name (platform_staff_only, unknown_view),
is granted to authenticated and never to anon, is STABLE and writes nothing.
Its three views are the adjustments queue (every Diamond row of
ca_manual_adjustments with its receipt, the count per status and what pays for
a correction), the health report as the hourly watch last read it, and the
trial balance with the register against supply.

The health report outlasts a signed-in request, so staff never run it. The
hourly watch keeps the whole reading it already takes in
ca_diamond_health_reading (one row, no client grant), changed only by asserted
substitution against its pinned text; a reading it cannot keep is a warning and
the watch goes on. The report itself is not redefined. The staff page is behind
PlatformStaffGuard and the Financial Admin Hub shows its link to platform staff
only.
