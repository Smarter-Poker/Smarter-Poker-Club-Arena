# Lightning Cycle Witness Records Why A Control Acknowledgment Was Unknown

Run 39969341289 reported both the Time Bank and the pre-action as click_or_response_unknown with no request sent, which cannot tell a lost pool selection from a control that was not clickable. Each control click now records fixed categories in clickOutcomes: clicked, selected_pool_unverified, control_not_clickable or click_failed, and whether a matching response was observed. No message text or page data is retained. Behavior is unchanged.

Tooling only.
