from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.database import Base


class PhotoQuizGame(Base):
    __tablename__ = "photo_quiz_games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mode = Column(String, nullable=False, default="online_friend")
    status = Column(String, nullable=False, default="waiting_for_opponent")
    join_code = Column(String(6), nullable=True, unique=True, index=True)
    target_wins = Column(Integer, nullable=False, default=3)
    wrong_guess_visibility = Column(String, nullable=False, default="private")
    player1_name = Column(String, nullable=True)
    player2_name = Column(String, nullable=True)
    player1_guest_id = Column(String(64), nullable=True)
    player2_guest_id = Column(String(64), nullable=True)
    player1_score = Column(Integer, nullable=False, default=0)
    player2_score = Column(Integer, nullable=False, default=0)
    round_number = Column(Integer, nullable=False, default=1)
    winner_player = Column(Integer, nullable=True)
    pending_no_answer_from = Column(Integer, nullable=True)
    pending_no_answer_to = Column(Integer, nullable=True)
    no_answer_offer_version = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    rounds = relationship(
        "PhotoQuizRound",
        back_populates="game",
        cascade="all, delete-orphan",
        order_by="PhotoQuizRound.round_number",
    )


class PhotoQuizRound(Base):
    __tablename__ = "photo_quiz_rounds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Integer, ForeignKey("photo_quiz_games.id"), nullable=False)
    round_number = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="active")
    answer_player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    solo_token_id = Column(Integer, nullable=True, unique=True, index=True)
    winner_player = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("game_id", "round_number", name="uq_photo_quiz_round"),
    )

    game = relationship("PhotoQuizGame", back_populates="rounds")
    answer_player = relationship("Player", foreign_keys=[answer_player_id])
    guesses = relationship(
        "PhotoQuizGuess",
        back_populates="round",
        cascade="all, delete-orphan",
        order_by="PhotoQuizGuess.created_at",
    )


class PhotoQuizGuess(Base):
    __tablename__ = "photo_quiz_guesses"

    id = Column(Integer, primary_key=True, autoincrement=True)
    round_id = Column(Integer, ForeignKey("photo_quiz_rounds.id"), nullable=False)
    player_number = Column(Integer, nullable=False)
    guessed_player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    is_correct = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    round = relationship("PhotoQuizRound", back_populates="guesses")
    guessed_player = relationship("Player", foreign_keys=[guessed_player_id])
