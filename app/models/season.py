from sqlalchemy import Column, Integer, String, ForeignKey
from sqlalchemy.orm import relationship

from app.database import Base


class Season(Base):
    __tablename__ = "seasons"

    id = Column(Integer, primary_key=True, autoincrement=True)
    year = Column(Integer, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    champion_team_id = Column(Integer, ForeignKey("teams.id"), nullable=True)

    champion_team = relationship("Team", foreign_keys=[champion_team_id])
    team_seasons = relationship("TeamSeason", back_populates="season")
    games = relationship("Game", back_populates="season")
    player_season_teams = relationship("PlayerSeasonTeam", back_populates="season")
