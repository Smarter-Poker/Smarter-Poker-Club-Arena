# New MTT Drafts Only Author Playing Levels

The custom blind editor offered manual and automatic break rows even though the tournament engine skips those rows. New preset drafts now contain only playing levels, and the editor exposes the existing synchronized-break policy instead of promising per-level pauses. The synchronized-break opt-out stays available; platform maintenance and add-on pauses retain their existing authority.

An explicitly loaded custom ladder is not silently rewritten. Unsupported break rows remain visible with an explanation and can be removed deliberately. The actual creation service and schedule serializer refuse a new MTT draft containing them. Historical preset definitions, funded tournament arrays and their level indices, and execution of already accepted saved schedules are unchanged. SNG/Spin terms, stacks, fees and payouts are unchanged.

Retained actual component/mapper/service regressions reproduce the previous behavior and pass with the change: initial UI red7/58, initial authoring red11/70, then177 assertions across8 related files. The additional real schedule-caller error case failed before its friendly message was connected and passes afterward (71/71 in that file). Four copy gates and19 surface assertions pass. The local application build, including `tsc -b`, completed; protected checks and public cold-load verification remain separate delivery stages.

A separate guarded two-RPC database change and18-assertion native probe are prepared for the maintained native composition. They are not part of this client-only commit and are not claimed installed. Client prevention alone does not prove every raw database authoring route refuses unsupported rows.

Real-time law: these are operator draft input events and request validation; no game-state authority, polling or snapshot-driven gameplay was added.
