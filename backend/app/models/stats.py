from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import relationship

from app.database import Base


class PlayerSeasonStats(Base):
    __tablename__ = "player_season_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    player_season_team_id = Column(
        Integer, ForeignKey("player_season_teams.id"), unique=True, nullable=False
    )
    games_played = Column(Integer, default=0)
    games_started = Column(Integer, default=0)
    minutes_played = Column(Integer, default=0)  # total seconds
    points = Column(Integer, default=0)
    two_points_made = Column(Integer, default=0)
    two_points_attempted = Column(Integer, default=0)
    three_points_made = Column(Integer, default=0)
    three_points_attempted = Column(Integer, default=0)
    free_throws_made = Column(Integer, default=0)
    free_throws_attempted = Column(Integer, default=0)
    offensive_rebounds = Column(Integer, default=0)
    defensive_rebounds = Column(Integer, default=0)
    total_rebounds = Column(Integer, default=0)
    assists = Column(Integer, default=0)
    steals = Column(Integer, default=0)
    turnovers = Column(Integer, default=0)
    blocks_favor = Column(Integer, default=0)
    blocks_against = Column(Integer, default=0)
    fouls_committed = Column(Integer, default=0)
    fouls_received = Column(Integer, default=0)
    pir = Column(Integer, default=0)

    player_season_team = relationship("PlayerSeasonTeam", back_populates="stats")


class GamePlayerStats(Base):
    __tablename__ = "game_player_stats"

    id = Column(Integer, primary_key=True, autoincrement=True)
    game_id = Column(Integer, ForeignKey("games.id"), nullable=False)
    player_id = Column(Integer, ForeignKey("players.id"), nullable=False)
    team_id = Column(Integer, ForeignKey("teams.id"), nullable=False)
    is_starter = Column(Boolean, default=False)
    minutes = Column(String, nullable=True)
    points = Column(Integer, default=0)
    two_points_made = Column(Integer, default=0)
    two_points_attempted = Column(Integer, default=0)
    three_points_made = Column(Integer, default=0)
    three_points_attempted = Column(Integer, default=0)
    free_throws_made = Column(Integer, default=0)
    free_throws_attempted = Column(Integer, default=0)
    offensive_rebounds = Column(Integer, default=0)
    defensive_rebounds = Column(Integer, default=0)
    total_rebounds = Column(Integer, default=0)
    assists = Column(Integer, default=0)
    steals = Column(Integer, default=0)
    turnovers = Column(Integer, default=0)
    blocks_favor = Column(Integer, default=0)
    blocks_against = Column(Integer, default=0)
    fouls_committed = Column(Integer, default=0)
    fouls_received = Column(Integer, default=0)
    plus_minus = Column(Integer, nullable=True)
    pir = Column(Integer, nullable=True)

    __table_args__ = (
        UniqueConstraint("game_id", "player_id", "team_id", name="uq_game_player_team"),
    )

    game = relationship("Game", back_populates="player_stats")
    player = relationship("Player")
    team = relationship("Team")
