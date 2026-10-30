# Authentication deadline loads before session ownership

The auth transport previously downloaded its deadline helper on the first auth
request, while auth-js could already own the shared native session lock. That
module download had no deadline, so a stalled chunk could prevent the existing
network/body timeout from ever starting.

Import the helper eagerly with the Supabase client. The branch-owned entry-module
fragment records this intentional first-paint dependency and its reason, while
preserving the existing reviewed-module guard and bundle-size budget. Authentication requests now
start their existing deadline without another module download. Native cross-tab
serialization, the single SDK token refresher, token persistence and existing
timeout/session-retention behavior remain intact. No lock stealing, recurring
repair, game reload or credential change is introduced.

The existing auth deadline suite now compiles the real client with code splitting
and checks the helper is included eagerly. This regression failed on the old
source. Existing real-SDK stalled-refresh and session-retention cases verify the
remaining timeout path. The precise cause of the earlier recovered Chrome
lock-holder stall was not captured; this change closes a demonstrated source gap
and does not guarantee browser or operating-system failures cannot recur.
