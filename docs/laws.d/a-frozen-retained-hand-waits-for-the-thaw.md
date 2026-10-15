# server/src/engine/aFrozenRetainedHandWaitsForTheThaw.law.test.ts

A cash start whose retained hand meets the platform freeze (HAND_SUBMISSION_PLATFORM_FROZEN or HAND_SUBMISSION_MAINTENANCE_BUSY from fn_ca_resume_hand_submission) keeps its generation and lease, stamps progress and asks the same door again at the thaw edge or after a pause of at most five seconds: no watchdog kill, no recovery row and no rebuild; it stops asking the moment the generation is no longer current, and every other refusal is still a start_failed kill.
