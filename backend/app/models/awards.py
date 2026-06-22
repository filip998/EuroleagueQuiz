from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from app.database import Base


class AwardDataRevision(Base):
    __tablename__ = "award_data_revisions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    award_key = Column(String(64), nullable=False, index=True)
    source_name = Column(String, nullable=False, index=True)
    source_url = Column(String, nullable=False)
    source_revision_id = Column(String, nullable=True, index=True)
    source_retrieved_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    content_hash = Column(String(64), nullable=False)
    status = Column(String, nullable=False, index=True)
    enabled_metric = Column(String(32), nullable=True)
    eligible_row_count = Column(Integer, nullable=False, default=0)
    accepted_row_count = Column(Integer, nullable=False, default=0)
    eligible_round_count = Column(Integer, nullable=False, default=0)
    threshold_round_count = Column(Integer, nullable=False, default=0)
    threshold_passed = Column(Boolean, nullable=False, default=False)
    report_path = Column(String, nullable=True)
    report_hash = Column(String, nullable=True)
    is_active = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    selections = relationship(
        "PlayerAwardSelection",
        back_populates="revision",
        cascade="all, delete-orphan",
        order_by="PlayerAwardSelection.source_order",
    )

    __table_args__ = (
        Index("ix_award_data_revisions_key_active", "award_key", "is_active"),
    )


class PlayerAwardSelection(Base):
    __tablename__ = "player_award_selections"

    id = Column(Integer, primary_key=True, autoincrement=True)
    revision_id = Column(
        Integer,
        ForeignKey("award_data_revisions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    award_key = Column(String(64), nullable=False, index=True)
    award_metric = Column(String(32), nullable=False, index=True)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=True, index=True)
    season_year = Column(Integer, nullable=False, index=True)
    source_row_key = Column(String, nullable=False)
    source_order = Column(Integer, nullable=False)
    source_position = Column(String, nullable=True)

    source_player_label = Column(String, nullable=False)
    source_player_url = Column(String, nullable=True)
    local_player_id = Column(Integer, ForeignKey("players.id"), nullable=True, index=True)

    source_team_label = Column(String, nullable=True)
    source_team_url = Column(String, nullable=True)
    local_team_id = Column(Integer, ForeignKey("teams.id"), nullable=True, index=True)

    status = Column(String, nullable=False, index=True)
    match_method = Column(String, nullable=True)
    reviewed = Column(Boolean, nullable=False, default=False)
    review_note = Column(Text, nullable=True)
    candidate_count = Column(Integer, nullable=False, default=0)
    candidates_json = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )

    revision = relationship("AwardDataRevision", back_populates="selections")
    season = relationship("Season")
    player = relationship("Player")
    team = relationship("Team")

    __table_args__ = (
        UniqueConstraint(
            "revision_id",
            "award_key",
            "award_metric",
            "season_year",
            "source_row_key",
            name="uq_player_award_selection_source_row",
        ),
        Index(
            "ix_player_award_selections_lookup",
            "award_key",
            "award_metric",
            "season_year",
            "status",
        ),
    )
