# Bound the hand-index concurrency fixture to its private clock

Required accounting run 35299527220 failed at `index-every-seat-first-a exceeded private deadline`. Its fixed September 13 hand/cursor seed made the real every-seat writer walk more empty hourly windows each day. The timeout was observed on the hosted worker; the same source passed locally.

While this task qualified a relative-clock repair, PR4823 independently merged the same root fix. The final integration adopts that protected-main implementation byte for byte, including its extra assertion that the cursor bounds the scan to three windows. The actual production functions, private deadlines, original deadlock reproduction and financial assertions are preserved. No second test or runtime change is added. Required hosted checks still run on the final integrated candidate.
