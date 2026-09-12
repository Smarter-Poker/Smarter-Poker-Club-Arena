# A prepared hand keeps its original controller

After asynchronous time-bank loading and financial start permission, the engine now verifies its original prepared controller, running state, process ownership and current lifecycle before pause cleanup or hand-start effects. A paused replacement controller is preserved, and an acquired publication token is released on refusal.

Update movement regression guards to follow the existing canonical receipt validator and durable table-close delegation. Add mismatched close-receipt cases that preserve ownership and reservations. The movement authority and financial delegates are unchanged.

Independent review verified controller, pause and token-release behavior, including negative controls. The combined current-source regression selection and complete server type check passed. Full CI, authenticated funded movement and served verification remain separate acceptance gates.
