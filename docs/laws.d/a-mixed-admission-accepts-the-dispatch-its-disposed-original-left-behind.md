# tests/a-mixed-admission-accepts-the-dispatch-its-disposed-original-left-behind.law.test.ts

A mixed custody transfer prepared while an original hand was in dispatch must be admissible once that hand is terminal: `public.fn_f06_admit_mixed_manager_custody` compares the snapshot's `hand_dispatch` without exactly the rows of the transfer's bound originals (an original still in dispatch stays pending and is refused `F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED`), compares every other key exactly as before, and the release contract pins carry the post-image it installs.
