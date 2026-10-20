# Scan repeated evidence filenames once

The pre-push source-contract selector searched the complete root test directory twice for every changed path. Strategy evidence repeats the same handful of basenames across hundreds of shards, so a 969-file selection spent minutes repeating identical scans; the SSH transport closed while those checks were still running.

Keep direct changed-source/test selection unchanged, then search each distinct basename once for TypeScript and Node contracts. Deleted paths remain included. The executable regression runs the maintained selector against 803 paths, including repeated shard files, an explicitly changed test and a deleted input. It preserves the same applicable tests while reducing recursive scans from 1,606 to 10. The regression fails on the previous hook and passes on the changed hook. No check, assertion or publication gate is bypassed.
