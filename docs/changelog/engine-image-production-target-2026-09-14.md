# Preserve the admitted image source while main advances

The release image producer still required its target to be the latest engine commit, although the release workflow now admits an exact forward target contained in protected main. A merge during preparation could therefore starve that producer before it installed or compiled its source.

The producer now retains the original target after proving both its source and captured executor remain in protected-main history. It returns and builds that target's server tree. The existing host seal remains responsible for refusing an actual backward cutover. Six real Git-history cases cover a later main, foreign target or executor, missing target, changed checkout and failed history refresh. An uncontained target still refuses before dependency installation.

This is preparation for production artifact delivery. It neither activates a host image importer nor grants deployment authority to a qualification artifact. Exact archive/image admission, host resource qualification and production verification remain separate requirements.
