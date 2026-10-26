set -eu
horse_journal_container=$(docker inspect --format '{{.Id}}' club-arena-engine)
case "$horse_journal_container" in ''|*[!0-9a-f]*) exit 3;; esac
[ "${#horse_journal_container}" -eq 64 ]
horse_journal_image=$(docker inspect --format '{{.Image}}' "$horse_journal_container")
docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$horse_journal_image"
docker exec -i "$horse_journal_container" node dist/scripts/horsePrivateJournalExport.js
