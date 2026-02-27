from datetime import datetime

from sqlalchemy import Column, DateTime, Float, Integer, String

from app.database import Base


class HigherLowerGame(Base):
    __tablename__ = "higher_lower_games"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tier = Column(String, nullable=False)  # easy, medium, hard
    season_range_start = Column(Integer, nullable=False)
    season_range_end = Column(Integer, nullable=False)
    nickname = Column(String, nullable=False)
    current_streak = Column(Integer, nullable=False, default=0)
    status = Column(String, nullable=False, default="active")  # active, finished
    # Track current pair so server is authoritative
    left_player_id = Column(Integer, nullable=True)
    right_player_id = Column(Integer, nullable=True)
    category = Column(String, nullable=True)
    left_value = Column(Float, nullable=True)
    right_value = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class HigherLowerScore(Base):
    __tablename__ = "higher_lower_scores"

    id = Column(Integer, primary_key=True, autoincrement=True)
    nickname = Column(String, nullable=False, index=True)
    tier = Column(String, nullable=False, index=True)
    streak = Column(Integer, nullable=False)
    played_at = Column(DateTime, nullable=False, default=datetime.utcnow)
