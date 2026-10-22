# Lightning Timing Correlation Scores Its Confidence Bound

Five TIMING_CORRELATION findings were raised HIGH on short paired-hand samples, and every one decayed to a correlation of about 0.13 to 0.27 once more hands were played. `fn_lightning_integrity_report` scored the pooled Pearson r directly as `40 + 50 * GREATEST(r, follow_share)`, so r 0.71 on 26 hands scored 76 (high) exactly as r 0.71 on 2,000 hands would. Sampling error at that size is large: a 99% one-sided lower bound on r 0.71 over 26 hands is about 0.38.

Migration `20261022042102` keeps detection exactly as it was: a pair is still flagged at 20 or more hands together, 30 or more sequential actions, and r of at least 0.7 or follow share of at least 0.5. Only the strength the correlation lends to the score changes. The score now uses the one-sided 99% Fisher-z lower confidence bound of r over the measured paired hands, `tanh(atanh(r) - 2.326 / sqrt(n - 3))` with r clamped inside (-1, 1), in place of r itself: `40 + 50 * GREATEST(r_lb, follow_share)`. The bound is recorded in the finding's evidence as `latency_corr_lower_bound_99`, and the returned thresholds name the method (`timing_corr_score_method`, `timing_corr_score_z`).

Follow-share scoring, DECISION_LATENCY, every other pattern, peak-score retention and every existing signal row are unchanged. The function's owner, SECURITY DEFINER, search_path and grants are kept by asserted substitution into the live definition.

## The Five Historical Findings Under The New Score

| Finding        | Paired hands | r      | Follow share | Old score | r lower bound | New score |
| -------------- | ------------ | ------ | ------------ | --------- | ------------- | --------- |
| 51 (Action 6)  | 23           | 0.7174 | 0.0286       | 76 high   | 0.365         | 58 medium |
| 141 (Action 6) | 34           | 0.7804 | 0.0857       | 79 high   | 0.557         | 68 medium |
| 158 (Action 6) | 27           | 0.7084 | 0.0938       | 75 high   | 0.388         | 59 medium |
| 159 (Action 6) | 26           | 0.7107 | 0.0000       | 76 high   | 0.383         | 59 medium |
| 50 (Madness 6) | 25           | 0.7340 | 0.0286       | 77 high   | 0.415         | 61 medium |

Old score is the score each finding's latest window produced. Existing rows are not rescored; peak retention still keeps their stored scores.

Strong evidence still reaches high: r 0.8 over 60 hands bounds at 0.66 and scores 73; r 0.8 over 100 hands scores 75; r 0.85 over 80 hands scores 78.

## Qualification

`scripts/dev/test-lightning-phase11-remediation.sh` runs the new fixture `scripts/dev/fixtures/lightning-integrity-confidence.sql` on the real PostgreSQL 17 chain before and after the file. Before, the 26-hand r 0.7107 pair scores 76 high, reproducing the defect. After, it is still detected and scores 59 medium with a lower bound of 0.383; an 80-hand r 0.85 pair remains high at 78; a follow share of 0.6 still scores 70 high; and r 0.65 with low follow share still raises no signal. The file's live proof and unchanged detection thresholds are asserted in the same run.
