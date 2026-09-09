# Replace exactly the nine operator-bound declarations in the reviewed
# tournament cutover. Callers supply every value with -v and must validate the
# values before invoking this file. The exact-hit guard makes source drift a
# hard failure instead of producing a partially rendered migration.

/^  c_engine_sha8 constant text :=/ {
  print "  c_engine_sha8 constant text := \047" engine_sha8 "\047;"
  hits_engine++
  next
}
/^  c_tournament_ids_csv constant text :=/ {
  print "  c_tournament_ids_csv constant text := \047" tournament_ids "\047;"
  hits_ids++
  next
}
/^  c_tournament_count constant integer :=/ {
  print "  c_tournament_count constant integer := " tournament_count ";"
  hits_tournaments++
  next
}
/^  c_table_count constant integer :=/ {
  print "  c_table_count constant integer := " table_count ";"
  hits_tables++
  next
}
/^  c_active_seat_count constant integer :=/ {
  print "  c_active_seat_count constant integer := " active_seat_count ";"
  hits_seats++
  next
}
/^  c_fractional_seat_count constant integer :=/ {
  print "  c_fractional_seat_count constant integer := " fractional_seat_count ";"
  hits_fractional++
  next
}
/^  c_total_chips constant numeric :=/ {
  print "  c_total_chips constant numeric := " total_chips ";"
  hits_total++
  next
}
/^  c_preimage_sha256 constant text :=/ {
  print "  c_preimage_sha256 constant text := \047" preimage_sha "\047;"
  hits_pre++
  next
}
/^  c_postimage_sha256 constant text :=/ {
  print "  c_postimage_sha256 constant text := \047" postimage_sha "\047;"
  hits_post++
  next
}
{ print }

END {
  if (hits_engine != 1 || hits_ids != 1 || hits_tournaments != 1 ||
      hits_tables != 1 || hits_seats != 1 || hits_fractional != 1 ||
      hits_total != 1 || hits_pre != 1 || hits_post != 1) exit 42
}
