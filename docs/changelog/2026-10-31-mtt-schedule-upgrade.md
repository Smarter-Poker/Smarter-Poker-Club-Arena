# MTT Schedule And Live Countdown

The MTT board defaults to Recommended, enables every game variant, and excludes satellites until Include Satellites is selected. Explicit saved choices remain remembered. The satellite control now sits beside Games.

Recommended groups late registration, starting soon, open registration, then running. Top events keep their existing current-day/weekly flagship eligibility, stay above ordinary events under every column sort, and use red title ink in both schedules. Compact names allow a third line and clocks have more readable type.

The board refreshes derived phases on its existing shared clock, so badge/order changes do not require an unrelated database update. Both schedule clock paths read the actual persisted start and the same bounded late-registration deadline. Remaining late-registration time is printed as minutes:seconds, including 75:30. An overdue event without a persisted start says Start Pending; it never falsely claims to be running.

Unfinished-event recovery is a separate existing financial/custody operation d44c4440-2911-430c-8ee7-376611ef3f38. This client change performs no financial or tournament lifecycle write. Original20 recovery source PR8913 is merged; runtime activation and receipts remain owned by the existing production operator. Live readback still showed89 stop_requested and zero recovery dispositions at investigation time.
