from sqlalchemy import Column, Integer, String, Date, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class Player(Base):
    __tablename__ = "players"

    id = Column(Integer, primary_key=True, autoincrement=True)
    euroleague_code = Column(String, unique=True, nullable=False, index=True)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    birth_date = Column(Date, nullable=True)
    nationality = Column(String, nullable=True)
    height_cm = Column(Integer, nullable=True)
    position = Column(String, nullable=True)
    image_url = Column(String, nullable=True)

    player_season_teams = relationship("PlayerSeasonTeam", back_populates="player")


class PlayerSeasonTeam(Base):
    __tablename__ = "player_season_teams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=False)
    jersey_number = Column(String, nullable=True)
    registration_start = Column(Date, nullable=True)
    registration_end = Column(Date, nullable=True)
    first_game_round = Column(Integer, nullable=True)
    last_game_round = Column(Integer, nullable=True)
    is_champion = Column(Boolean, default=False)

    __table_args__ = (
        UniqueConstraint("player_id", "team_id", "season_id", name="uq_player_team_season"),
    )

    player = relationship("Player", back_populates="player_season_teams")
    team = relationship("Team")
    season = relationship("Season", back_populates="player_season_teams")
    stats = relationship("PlayerSeasonStats", back_populates="player_season_team", uselist=False)
