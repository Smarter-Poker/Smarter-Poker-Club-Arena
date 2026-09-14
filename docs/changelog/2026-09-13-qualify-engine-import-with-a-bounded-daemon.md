# Qualify engine import with a bounded daemon

The disposable Linux resource lane now loads its existing normalized engine archive through a separate, pinned Docker 29.7.2 daemon and its managed containerd. A fresh systemd unit bounds the worker and both daemons together to 512 MiB, no swap and one CPU. The importer checks the real process cgroups, empty initial image store, engine image identity, source labels and every emitted runtime file. It then stops and removes its owned daemon, store, mounts, unit and cgroup.

Three additional fresh imports exercise wrong image identity, wrong runtime bytes and a real signal delivered to the worker after image load. Each must reach its specific refusal, retain failure status, show no unexpected OOM and complete every cleanup observation. Failed startup or missing evidence cannot stand in for the intended fault. The importer preserves its memory-event baseline from before daemon startup and checks again after shutdown. An OOM during either phase cannot earn clean-refusal credit. The existing real build OOM and wrapper faults remain mandatory.

The surrounding resource test now requires the same neighboring process to remain live through its final observation. Removal is confirmed through successful inventories; a failed inspection cannot prove absence. Cleanup continues after individual command errors, saves a failed receipt, and removes only its exact image tags and generated candidate tags.

The Docker source archive has a fixed URL, byte count and SHA-256. Only its eight expected regular executable files may be extracted, exclusively in disposable Linux CI. The engine is compiled once; all imports use the same verified archive.

Local tests simulate the receipt and cleanup protocols. Native execution remains required. The archive was prepared in the same runner, so this does not prove a cold-cache budget, total host memory usage, producer authentication or production-host import safety. It does not change production resources or deployment behavior.
