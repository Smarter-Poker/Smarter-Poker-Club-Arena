"""Retained real financial foundation for the explicit tournament-abort proof.

This installs the same source-checked payer/cancellation catalog as the existing
cancellation-lane runner. It does not repeat that runner's unchanged admission
scenarios. Callers add their exact current F06/Diamond dependencies and exercise
the candidate abort through its real transaction owners.
"""

import hashlib
import json
from pathlib import Path

from satellite_qualifier_fixture import module


def install_financial_foundation(e, db: str, root: Path, output: Path) -> None:
    root = Path(root)
    output = Path(output)
    data = root / "scripts/ci/fixtures/tournament-cancellation-lane"
    catalog = module(root / "scripts/ci/satellite_qualifier_fixture.py", "abort_financial_catalog")
    foundation = catalog.compose(root)
    source_hashes = e.report.setdefault("source_sha256", {})
    source_hashes.update(foundation["source_sha256"])

    def retain(path: Path) -> None:
        source_hashes[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()

    def install_file(path: Path, label: str, seconds: int = 30) -> None:
        retain(path)
        e.sql(db, file=path, label=label, seconds=seconds)

    foundation_file = output / "abort-financial-foundation.sql"
    foundation_file.write_text(foundation["sql"] + foundation["entry_sql"])
    e.sql(db, file=foundation_file, label="abort-retained-real-financial-catalog", seconds=180)
    install_file(
        root / "scripts/ci/fixtures/satellite-qualifiers/entry-club-cancellation-cash-read.sql",
        "abort-retained-cancellation-cash-read-dependency",
    )

    fixtures = [data / "preimages.json", data / "accounting-dependencies.json"]
    rows = []
    for path in fixtures:
        retain(path)
        rows.extend(json.loads(path.read_text()))
    setup = (
        "SET check_function_bodies=off;CREATE SCHEMA IF NOT EXISTS smarter_private;"
        "CREATE TABLE IF NOT EXISTS public.ca_operator_tournament_operations("
        "op_id uuid,tournament_id uuid,actor_id uuid,reason text,review_snapshot jsonb,"
        "amount numeric,asset text,approval_id uuid,state text,result jsonb,"
        "created_at timestamptz,completed_at timestamptz);"
    )
    for row in rows:
        if hashlib.md5(row["definition"].encode()).hexdigest() != row["definition_md5"]:
            raise AssertionError(f"retained financial definition changed: {row['signature']}")
        signature = "public." + row["signature"]
        setup += row["definition"] + ";REVOKE ALL ON FUNCTION " + signature + " FROM PUBLIC,anon,authenticated,service_role;"
        if "service_role=X/" in row["proacl"]:
            setup += "GRANT EXECUTE ON FUNCTION " + signature + " TO service_role;"
    current_catalog = output / "abort-retained-financial-owners.sql"
    current_catalog.write_text(setup)
    e.sql(db, file=current_catalog, label="abort-exact-installed-financial-dependencies")

    doctrine_path = data / "doctrine.json"
    retain(doctrine_path)
    doctrine = json.loads(doctrine_path.read_text())
    if hashlib.md5(doctrine["definition"].encode()).hexdigest() != doctrine["definition_md5"]:
        raise AssertionError("retained settlement lane doctrine changed")
    e.sql(
        db,
        doctrine["definition"]
        + ";REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC,anon,authenticated,service_role;"
        + "GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;",
        label="abort-retained-installed-lane-doctrine",
    )

    lane = root / "supabase/migrations/20261030004352_tournament_cancellation_keeps_unrelated_hands_in_their_own_l.sql"
    install_file(lane, "abort-retained-exact-cancellation-lane")
    proof_prefix = "-- @live-proof: "
    proof = next(line[len(proof_prefix):] for line in lane.read_text().splitlines() if line.startswith(proof_prefix))
    _, result, _ = e.sql(db, "SELECT " + proof + ";", label="abort-retained-lane-source-proof")
    if result.strip() != "t":
        raise AssertionError("retained cancellation lane source proof did not pass")
    install_file(
        root / "supabase/migrations/20261030142407_a_free_diamond_registration_closes_as_zero_disposition.sql",
        "abort-retained-free-diamond-disposition",
    )
    retain(Path(__file__))
