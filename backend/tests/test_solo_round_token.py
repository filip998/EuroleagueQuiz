from datetime import datetime, timedelta, timezone

import pytest

from app.services.solo_round_token import (
    SoloRoundTokenError,
    create_solo_round_token,
    validate_solo_round_token,
)


def test_solo_round_token_round_trip():
    token = create_solo_round_token(
        player_id=42,
        data_revision="rev1",
        secret="secret",
        issued_at=datetime.now(timezone.utc),
    )

    payload = validate_solo_round_token(
        token,
        current_data_revision="rev1",
        secret="secret",
    )

    assert payload.player_id == 42
    assert payload.data_revision == "rev1"


def test_solo_round_token_rejects_tampering():
    token = create_solo_round_token(player_id=42, data_revision="rev1", secret="secret")
    replacement = "A" if token[-1] != "A" else "B"
    tampered = f"{token[:-1]}{replacement}"

    with pytest.raises(SoloRoundTokenError):
        validate_solo_round_token(
            tampered,
            current_data_revision="rev1",
            secret="secret",
        )


def test_solo_round_token_rejects_stale_revision():
    token = create_solo_round_token(player_id=42, data_revision="rev1", secret="secret")

    with pytest.raises(SoloRoundTokenError, match="Stale"):
        validate_solo_round_token(
            token,
            current_data_revision="rev2",
            secret="secret",
        )


def test_solo_round_token_rejects_expired_token():
    token = create_solo_round_token(
        player_id=42,
        data_revision="rev1",
        secret="secret",
        issued_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )

    with pytest.raises(SoloRoundTokenError, match="Expired"):
        validate_solo_round_token(
            token,
            current_data_revision="rev1",
            secret="secret",
            max_age=timedelta(hours=1),
        )
