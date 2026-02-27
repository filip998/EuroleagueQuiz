from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class RosterGuessGame(Base):
    __tablename__ = "roster_guess_games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mode = Column(String, nullable=False)  # single_player, local_two_player, online_friend
    status = Column(String, nullable=False, default="active")  # waiting_for_opponent, active, finished
    join_code = Column(String(6), nullable=True, unique=True, index=True)
    target_wins = Column(Integer, nullable=False)
    turn_seconds = Column(Integer, nullable=True)
    turn_started_at = Column(DateTime, nullable=True)

    player1_name = Column(String, nullable=True)
    player2_name = Column(String, nullable=True)
    player1_score = Column(Integer, nullable=False, default=0)
    player2_score = Column(Integer, nullable=False, default=0)
    current_player = Column(Integer, nullable=False, default=1)
    round_number = Column(Integer, nullable=False, default=1)
    winner_player = Column(Integer, nullable=True)

    season_range_start = Column(Integer, nullable=False)
    season_range_end = Column(Integer, nullable=False)

    # End-of-round offer (like draw in TicTacToe)
    pending_end_from = Column(Integer, nullable=True)
    pending_end_to = Column(Integer, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    rounds = relationship(
        "RosterGuessRound",
        back_populates="game",
        cascade="all, delete-orphan",
        order_by="RosterGuessRound.round_number",
    )


class RosterGuessRound(Base):
    __tablename__ = "roster_guess_rounds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Integer, ForeignKey("roster_guess_games.id"), nullable=False)
    round_number = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="active")

    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=False)
    team_code = Column(String, nullable=False)
    team_name = Column(String, nullable=False)
    season_year = Column(Integer, nullable=False)

    player1_correct = Column(Integer, nullable=False, default=0)
    player2_correct = Column(Integer, nullable=False, default=0)
    winner_player = Column(Integer, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("game_id", "round_number", name="uq_roster_guess_round"),
    )

    game = relationship("RosterGuessGame", back_populates="rounds")
    team = relationship("Team", foreign_keys=[team_id])
    season = relationship("Season", foreign_keys=[season_id])
    slots = relationship(
        "RosterGuessSlot",
        back_populates="round",
        cascade="all, delete-orphan",
    )


class RosterGuessSlot(Base):
    __tablename__ = "roster_guess_slots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    round_id = Column(Integer, ForeignKey("roster_guess_rounds.id"), nullable=False)
    player_season_team_id = Column(
        Integer, ForeignKey("player_season_teams.id"), nullable=False
    )
    player_id = Column(Integer, ForeignKey("players.id"), nullable=False)

    # Hints (denormalized for fast serialization)
    jersey_number = Column(String, nullable=True)
    position = Column(String, nullable=True)
    nationality = Column(String, nullable=True)
    height_cm = Column(Integer, nullable=True)
    player_name = Column(String, nullable=False)  # the answer

    guessed_by_player = Column(Integer, nullable=True)
    guessed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("round_id", "player_id", name="uq_roster_guess_slot"),
    )

    round = relationship("RosterGuessRound", back_populates="slots")
    player = relationship("Player")
    player_season_team = relationship("PlayerSeasonTeam")
