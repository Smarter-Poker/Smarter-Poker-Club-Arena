# Model the host of the modeled process boundary

The normal Mac push check failed 34 process-boundary unit cases before their
assertions because their setup required the real workstation to be Linux. The
suite already replaces process creation and priority reads with a modeled child.
It now models the Linux host in that same isolated unit fixture and restores the
original property after each test. Added Darwin and Windows cases still require
the production launcher to refuse before spawning. Production code and the real
Linux process/thread qualification are unchanged.
