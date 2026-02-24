from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class QuizTicTacToeGame(Base):
    __tablename__ = "quiz_ttt_games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    mode = Column(String, nullable=False)
    status = Column(String, nullable=False, default="active")
    join_code = Column(String(6), nullable=True, unique=True, index=True)
    target_wins = Column(Integer, nullable=False)
    turn_seconds = Column(Integer, nullable=True)
    player1_name = Column(String, nullable=True)
    player2_name = Column(String, nullable=True)
    player1_score = Column(Integer, nullable=False, default=0)
    player2_score = Column(Integer, nullable=False, default=0)
    current_player = Column(Integer, nullable=False, default=1)
    round_number = Column(Integer, nullable=False, default=1)
    pending_draw_from = Column(Integer, nullable=True)
    pending_draw_to = Column(Integer, nullable=True)
    winner_player = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    rounds = relationship(
        "QuizTicTacToeRound",
        back_populates="game",
        cascade="all, delete-orphan",
        order_by="QuizTicTacToeRound.round_number",
    )


class QuizTicTacToeRound(Base):
    __tablename__ = "quiz_ttt_rounds"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Integer, ForeignKey("quiz_ttt_games.id"), nullable=False)
    round_number = Column(Integer, nullable=False)
    status = Column(String, nullable=False, default="active")
    row_team_id_1 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    row_team_id_2 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    row_team_id_3 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    col_team_id_1 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    col_team_id_2 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    col_team_id_3 = Column(Integer, ForeignKey("teams.id"), nullable=True)
    started_by_player = Column(Integer, nullable=False, default=1)
    winner_player = Column(Integer, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("game_id", "round_number", name="uq_quiz_ttt_round"),
    )

    game = relationship("QuizTicTacToeGame", back_populates="rounds")
    row_team_1 = relationship("Team", foreign_keys=[row_team_id_1])
    row_team_2 = relationship("Team", foreign_keys=[row_team_id_2])
    row_team_3 = relationship("Team", foreign_keys=[row_team_id_3])
    col_team_1 = relationship("Team", foreign_keys=[col_team_id_1])
    col_team_2 = relationship("Team", foreign_keys=[col_team_id_2])
    col_team_3 = relationship("Team", foreign_keys=[col_team_id_3])
    cells = relationship(
        "QuizTicTacToeCell",
        back_populates="round",
        cascade="all, delete-orphan",
    )
    axes = relationship(
        "QuizTicTacToeAxis",
        back_populates="round",
        cascade="all, delete-orphan",
    )


class QuizTicTacToeCell(Base):
    __tablename__ = "quiz_ttt_cells"

    id = Column(Integer, primary_key=True, autoincrement=True)
    round_id = Column(Integer, ForeignKey("quiz_ttt_rounds.id"), nullable=False)
    row_index = Column(Integer, nullable=False)
    col_index = Column(Integer, nullable=False)
    claimed_by_player = Column(Integer, nullable=True)
    claimed_player_id = Column(Integer, ForeignKey("players.id"), nullable=True)
    claimed_at = Column(DateTime, nullable=True)

    __table_args__ = (
        UniqueConstraint("round_id", "row_index", "col_index", name="uq_quiz_ttt_cell"),
    )

    round = relationship("QuizTicTacToeRound", back_populates="cells")
    claimed_player = relationship("Player")


class QuizTicTacToeAxis(Base):
    __tablename__ = "quiz_ttt_axes"

    id = Column(Integer, primary_key=True, autoincrement=True)
    round_id = Column(Integer, ForeignKey("quiz_ttt_rounds.id"), nullable=False)
    position = Column(String, nullable=False)  # "row_0", "row_1", "row_2", "col_0", "col_1", "col_2"
    axis_type = Column(String, nullable=False)  # "team", "nationality", ...
    value = Column(String, nullable=False)  # team_id (as str) or nationality name
    display_label = Column(String, nullable=False)  # "Real Madrid", "Serbia", etc.

    __table_args__ = (
        UniqueConstraint("round_id", "position", name="uq_quiz_ttt_axis"),
    )

    round = relationship("QuizTicTacToeRound", back_populates="axes")
