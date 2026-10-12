# tests/two-windows-are-a-boundary-three-are-a-drift.law.test.ts

The trial balance watch files a drift only after three consecutive hourly readings over the threshold in the same direction, because a movement split across a snapshot cut reads +x then -x and a real leak does not reverse.
