# Player Command Simple Phone Input

The approved Simple roster added a 14px phone override to the Sort Players field. The maintained production input-zoom sweep demonstrated this at 375px; iPhone form fields need at least 16px to avoid automatic zoom. The field now keeps 16px while preserving the existing compact toolbar, Simple default and Advanced controls.

The existing CSS containment suite now renders the actual Simple toolbar at 375px and 393px and checks computed field sizes, touch height and parent/content containment. Both new cases failed before the source correction with expected 16px and actual 14px. The maintained six-case production roster suite checks the Simple sort font before opening Advanced at phone widths. Existing roster, history, privacy and export assertions are retained.

Real-time law: triggered by existing history_changed discrete WS event, no snapshot diff. This correction changes only field typography and regression coverage; no database migration or engine activation is required.
