import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.game_actions import ConflictGameActionError
from app.models import (
    CareerDataRevision,
    Player,
    PlayerCareerSourceMapping,
    PlayerCareerStint,
)
from app.services import career_quiz


def test_format_years_uses_wikipedia_calendar_style():
    from types import SimpleNamespace

    def years(raw_start, raw_end, is_current, start_year=None):
        stint = SimpleNamespace(
            raw_start=raw_start,
            raw_end=raw_end,
            is_current=is_current,
            start_season_year=start_year,
        )
        return career_quiz._format_years(stint)

    assert years("1999", "2004", False) == "1999\u20132004"
    assert years("2010", "2010", False) == "2010"
    assert years("2024", None, True) == "2024\u2013present"
    assert years(None, None, False, start_year=2015) == "2015\u2013present"


def test_solo_round_guess_and_reveal():
    db = _session()
    try:
        answer = _eligible_player(db, "Nikos", "Zisis")
        other = _eligible_player(db, "Other", "Player")
        _active_revision(db)

        round_data = career_quiz.create_solo_round(db, recent_player_ids=[other.id])
        assert len(round_data["timeline"]) == 3

        guess = career_quiz.submit_solo_guess(
            db,
            round_token=round_data["round_token"],
            player_id=other.id,
        )
        assert guess == {"correct": False}

        reveal = career_quiz.reveal_solo_answer(db, round_token=round_data["round_token"])
        assert reveal["answer"]["id"] in {answer.id, other.id}
    finally:
        db.close()


def test_autocomplete_uses_only_eligible_career_players():
    db = _session()
    try:
        eligible = _eligible_player(db, "Milos", "Teodosic")
        ineligible = Player(euroleague_code="PINELIG", first_name="Milos", last_name="Missing")
        db.add(ineligible)
        _active_revision(db)
        db.commit()

        players = career_quiz.autocomplete_players(db, q="milos")

        assert [player["id"] for player in players] == [eligible.id]
    finally:
        db.close()


def test_multiplayer_first_correct_answer_wins_match_when_target_is_one():
    db = _session()
    try:
        answer = _eligible_player(db, "Saras", "Jasikevicius")
        wrong = _eligible_player(db, "Wrong", "Guess")
        _active_revision(db)
        db.commit()

        game = career_quiz.create_game(db, target_wins=1, player1_name="A")
        career_quiz.join_game(db, game.join_code, player_name="B")
        current = game.rounds[0]
        wrong_id = wrong.id if current.answer_player_id == answer.id else answer.id

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=wrong_id,
            acting_player=2,
        )
        assert result == "incorrect"

        result = career_quiz.submit_guess(
            db,
            game=game,
            player_id=current.answer_player_id,
            acting_player=1,
        )

        assert result == "match_won"
        assert game.status == "finished"
        assert game.winner_player == 1
        assert career_quiz.serialize_completed_round(db, game.id, 1)["answer"]["id"] == current.answer_player_id
    finally:
        db.close()


def test_low_threshold_revision_does_not_enable_quiz():
    db = _session()
    try:
        _eligible_player(db, "Low", "Threshold")
        revision = CareerDataRevision(
            revision="low-threshold",
            status="active",
            eligible_player_count=20,
            threshold_player_count=20,
            threshold_passed=True,
            is_active=True,
        )
        db.add(revision)
        db.commit()

        with pytest.raises(ConflictGameActionError, match="Career Quiz is not enabled"):
            career_quiz.create_solo_round(db, recent_player_ids=[])
    finally:
        db.close()


def _session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _active_revision(db):
    revision = CareerDataRevision(
        revision="test-revision",
        status="active",
        eligible_player_count=200,
        threshold_player_count=200,
        threshold_passed=True,
        is_active=True,
    )
    db.add(revision)
    return revision


def _eligible_player(db, first_name: str, last_name: str):
    player = Player(
        euroleague_code=f"P{first_name}{last_name}",
        first_name=first_name,
        last_name=last_name,
    )
    db.add(player)
    db.flush()
    mapping = PlayerCareerSourceMapping(
        player_id=player.id,
        source_name="wikipedia",
        source_player_key=f"wiki:{player.id}",
        source_player_label=f"{first_name} {last_name}",
        source_player_url=f"https://en.wikipedia.org/wiki/{first_name}_{last_name}",
        status="accepted",
        candidate_count=1,
    )
    db.add(mapping)
    db.flush()
    for index in range(3):
        db.add(
            PlayerCareerStint(
                mapping_id=mapping.id,
                player_id=player.id,
                sequence_index=index + 1,
                source_name="wikipedia",
                source_player_key=mapping.source_player_key,
                source_team_key=f"T{player.id}{index}",
                source_team_label=f"Team {index}",
                start_season=f"200{index}/0{index + 1}",
                start_season_year=2000 + index,
                include_in_quiz=True,
            )
        )
    db.flush()
    return player
