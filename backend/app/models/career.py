from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.database import Base


class PlayerWikidataMapping(Base):
    __tablename__ = "player_wikidata_mappings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    player_id = Column(Integer, ForeignKey("players.id"), nullable=False, unique=True)
    wikidata_qid = Column(String, nullable=True, index=True)
    wikidata_label = Column(String, nullable=True)
    wikidata_birth_date = Column(Date, nullable=True)
    status = Column(String, nullable=False, index=True)
    match_method = Column(String, nullable=True)
    reviewed = Column(Boolean, nullable=False, default=False)
    review_note = Column(Text, nullable=True)
    candidate_count = Column(Integer, nullable=False, default=0)
    candidates_json = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    last_checked_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    player = relationship("Player")
    stints = relationship(
        "PlayerCareerStint",
        back_populates="mapping",
        cascade="all, delete-orphan",
        order_by="PlayerCareerStint.sequence_index",
    )


class PlayerCareerStint(Base):
    __tablename__ = "player_career_stints"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mapping_id = Column(
        Integer, ForeignKey("player_wikidata_mappings.id"), nullable=False
    )
    player_id = Column(Integer, ForeignKey("players.id"), nullable=False, index=True)
    sequence_index = Column(Integer, nullable=False)

    wikidata_player_qid = Column(String, nullable=False, index=True)
    wikidata_team_qid = Column(String, nullable=False, index=True)
    wikidata_team_label = Column(String, nullable=False)
    wikidata_statement_id = Column(String, nullable=True)

    raw_start = Column(String, nullable=True)
    raw_start_precision = Column(Integer, nullable=True)
    raw_end = Column(String, nullable=True)
    raw_end_precision = Column(Integer, nullable=True)
    start_season = Column(String, nullable=True)
    end_season = Column(String, nullable=True)
    start_season_year = Column(Integer, nullable=True)
    end_season_year = Column(Integer, nullable=True)

    is_current = Column(Boolean, nullable=False, default=False)
    is_loan = Column(Boolean, nullable=False, default=False)
    include_in_quiz = Column(Boolean, nullable=False, default=True, index=True)
    exclusion_reason = Column(String, nullable=True)
    source_retrieved_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("mapping_id", "sequence_index", name="uq_career_stint_order"),
    )

    mapping = relationship("PlayerWikidataMapping", back_populates="stints")
    player = relationship("Player")


class CareerDataRevision(Base):
    __tablename__ = "career_data_revisions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    revision = Column(String, nullable=False, unique=True, index=True)
    status = Column(String, nullable=False, index=True)
    eligible_player_count = Column(Integer, nullable=False, default=0)
    threshold_player_count = Column(Integer, nullable=False, default=200)
    threshold_passed = Column(Boolean, nullable=False, default=False)
    report_path = Column(String, nullable=True)
    report_hash = Column(String, nullable=True)
    is_active = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class CareerQuizGame(Base):
    __tablename__ = "career_quiz_games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mode = Column(String, nullable=False, default="online_friend")
    status = Column(String, nullable=False, default="waiting_for_opponent")
    join_code = Column(String(6), nullable=True, unique=True, index=True)
    target_wins = Column(Integer, nullable=False, default=3)
    wrong_guess_visibility = Column(String, nullable=False, default="private")
    player1_name = Column(String, nullable=True)
    player2_name = Column(String, nullable=True)
    player1_score = Column(Integer, nullable=False, default=0)
    player2_score = Column(Integer, nullable=False, default=0)
    round_number = Column(Integer, nullable=False, default=1)
    winner_player = Column(Integer, nullable=True)
    pending_no_answer_from = Column(Integer, nullable=True)
    pending_no_answer_to = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    rounds = relationship(
        "CareerQuizRound",
        back_populates="game",
        cascade="all, delete-orphan",
        order_by="CareerQuizRound.round_number",
    )


class CareerQuizRound(Base):
    __tablename__ = "career_quiz_rounds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Integer, ForeignKey("career_quiz_games.id"), nullable=False)
    round_number = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="active")
    answer_player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    winner_player = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("game_id", "round_number", name="uq_career_quiz_round"),
    )

    game = relationship("CareerQuizGame", back_populates="rounds")
    answer_player = relationship("Player")
    guesses = relationship(
        "CareerQuizGuess",
        back_populates="round",
        cascade="all, delete-orphan",
        order_by="CareerQuizGuess.created_at",
    )


class CareerQuizGuess(Base):
    __tablename__ = "career_quiz_guesses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    round_id = Column(Integer, ForeignKey("career_quiz_rounds.id"), nullable=False)
    player_number = Column(Integer, nullable=False)
    guessed_player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    is_correct = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    round = relationship("CareerQuizRound", back_populates="guesses")
    guessed_player = relationship("Player")
