# A Satellite Waiting For Its Target Is Not A Missed Event

**Date:** 2026-10-09

The missed-occurrence page (`ScheduledTournaments.occurrence_not_created`) fires when a scheduled event due within the hour cannot be created. A daily satellite that feeds a weekly target is skipped by design until that target exists ("no pre-start satellite target matching ..."), and that skip would have paged every such satellite schedule several days a week. The skip is now recorded per occurrence and never pages; every other refusal still does.
