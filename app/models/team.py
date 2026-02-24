from sqlalchemy import Column, Integer, String, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class Team(Base):
    __tablename__ = "teams"

    id = Column(Integer, primary_key=True, autoincrement=True)
    euroleague_code = Column(String, unique=True, nullable=False, index=True)
    name = Column(String, nullable=False)
    country = Column(String, nullable=True)
    logo_url = Column(String, nullable=True)

    team_seasons = relationship("TeamSeason", back_populates="team")


class TeamSeason(Base):
    __tablename__ = "team_seasons"

    id = Column(Integer, primary_key=True, autoincrement=True)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=False)
    team_name_that_season = Column(String, nullable=True)

    __table_args__ = (
        UniqueConstraint("team_id", "season_id", name="uq_team_season"),
    )

    team = relationship("Team", back_populates="team_seasons")
    season = relationship("Season", back_populates="team_seasons")
