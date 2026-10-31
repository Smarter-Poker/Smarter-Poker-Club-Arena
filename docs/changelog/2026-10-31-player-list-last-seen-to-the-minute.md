# Player list last seen counts minutes and hours (2026-10-31)

Dan: "IF ITS 'SEEN TODAY' CHANGE IT TO SEEN AN HOUR AGO, OR 2 HOURS AGO. OR TO
THE MINUTE IF THE DATA IS AVAILABLE".

The roster's `last_login` is a full timestamp (the latest of sign-in, presence
and member activity, since `20261015093645`), so the player rows no longer
round everything inside a day to "Seen Today":

| Age            | Label                               |
| -------------- | ----------------------------------- |
| under a minute | Seen Just Now                       |
| 1-59 minutes   | Seen 14 Mins Ago                    |
| 1-23 hours     | Seen 2 Hours Ago                    |
| a day or more  | Seen 8d Ago (unchanged: d / mo / y) |

- `src/utils/memberLastSeen.ts` builds the label.
- `src/hooks/useSharedMinuteTick.ts` is one shared once-a-minute clock; only
  rows seen inside the last day subscribe, so an open list stays current
  without a timer per row.
- `tests/unit/memberLastSeen.test.ts` pins the labels;
  `tests/e2e/css/club-members-containment.spec.ts` now fits the longest one,
  "Seen 23 Hours Ago", at 320-430px.
