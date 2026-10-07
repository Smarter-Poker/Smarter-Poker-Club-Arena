# A live hand label is one accessible text value

Physical Chrome opened the live table menu and displayed a real hand number, but its native accessibility observer could not match the complete label. An independent browser accessibility read showed separate StaticText nodes for `Hand #` and the number. React rendered those as two adjacent text children.

TableMenu now renders the same public hand label as one string child. Both existing menu callers inherit the correction; appearance, public engine identity, table selection, actions, timing and financial behavior are unchanged. The existing rendered menu regression checks one text node before and after a new hand while retaining active-table isolation.

The regression failed before the correction (one failure, eight passes). Protected checks, publication and physical-device verification remain required separately.
