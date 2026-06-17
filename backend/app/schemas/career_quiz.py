import unicodedata
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class CareerSoloRoundRequest(BaseModel):
    recent_player_ids: list[int] = Field(default_factory=list)


class CareerSoloGuessRequest(BaseModel):
    round_token: str
    player_id: int = Field(gt=0)


class CareerSoloRevealRequest(BaseModel):
    round_token: str


class CareerSoloHintRequest(BaseModel):
    round_token: str
    shown_hints: list[Literal["nationality", "position", "name_skeleton"]] = Field(
        default_factory=list
    )
    revealed_letters: list[str] = Field(default_factory=list)

    @field_validator("revealed_letters")
    @classmethod
    def normalize_revealed_letters(cls, values: list[str]) -> list[str]:
        normalized = []
        seen = set()
        for value in values:
            letter = value.strip()
            if len(letter) != 1:
                raise ValueError("revealed_letters must contain single letters")
            normalized_letters = [
                character
                for character in unicodedata.normalize("NFKD", letter.casefold())
                if character.isalpha()
            ]
            if not normalized_letters:
                raise ValueError("revealed_letters must contain single letters")
            key = normalized_letters[0]
            if key not in seen:
                seen.add(key)
                normalized.append(key)
        return normalized


class CareerQuizCreateRequest(BaseModel):
    target_wins: Literal[1, 3, 5, 7] = 3
    wrong_guess_visibility: Literal["private", "shared"] = "private"
    player1_name: str | None = None
    guest_id: str | None = None


class CareerQuizJoinRequest(BaseModel):
    join_code: str = Field(min_length=6, max_length=6)
    player_name: str | None = None
    guest_id: str | None = None


class CareerQuizGuessRequest(BaseModel):
    player_id: int = Field(gt=0)
    round_number: int = Field(gt=0)


class CareerQuizNoAnswerOfferRequest(BaseModel):
    round_number: int = Field(gt=0)


class CareerQuizNoAnswerResponseRequest(BaseModel):
    accept: bool
    round_number: int = Field(gt=0)
