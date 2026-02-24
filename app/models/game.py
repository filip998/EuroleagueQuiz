from sqlalchemy import Column, Integer, String, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class Game(Base):
    __tablename__ = "games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=False)
    euroleague_gamecode = Column(Integer, nullable=False)
    round = Column(Integer, nullable=True)
    phase = Column(String, nullable=True)
    game_date = Column(String, nullable=True)
    game_time = Column(String, nullable=True)
    home_team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    away_team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    home_score = Column(Integer, nullable=True)
    away_score = Column(Integer, nullable=True)

    __table_args__ = (
        UniqueConstraint("season_id", "euroleague_gamecode", name="uq_season_gamecode"),
    )

    season = relationship("Season", back_populates="games")
    home_team = relationship("Team", foreign_keys=[home_team_id])
    away_team = relationship("Team", foreign_keys=[away_team_id])
    player_stats = relationship("GamePlayerStats", back_populates="game")
