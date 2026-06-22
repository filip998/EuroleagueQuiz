from app.models.season import Season
from app.models.team import Team, TeamSeason
from app.models.player import Player, PlayerSeasonTeam
from app.models.game import Game
from app.models.stats import PlayerSeasonStats, GamePlayerStats
from app.models.tictactoe import (
    QuizTicTacToeGame,
    QuizTicTacToeRound,
    QuizTicTacToeCell,
    QuizTicTacToeAxis,
    QuizTicTacToeStatMilestonePlayer,
)
from app.models.guess_the_list import (
    GuessTheListGame,
    GuessTheListRound,
    GuessTheListSlot,
)
from app.models.awards import AwardDataRevision, PlayerAwardSelection
from app.models.higher_lower import (
    HigherLowerGame,
    HigherLowerScore,
)
from app.models.career import (
    CareerDataRevision,
    CareerQuizGame,
    CareerQuizGuess,
    CareerQuizRound,
    PlayerCareerStint,
    PlayerCareerSourceMapping,
)
from app.models.photo_quiz import (
    PhotoQuizGame,
    PhotoQuizGuess,
    PhotoQuizRound,
)

__all__ = [
    "Season",
    "Team",
    "TeamSeason",
    "Player",
    "PlayerSeasonTeam",
    "Game",
    "PlayerSeasonStats",
    "GamePlayerStats",
    "QuizTicTacToeGame",
    "QuizTicTacToeRound",
    "QuizTicTacToeCell",
    "QuizTicTacToeAxis",
    "QuizTicTacToeStatMilestonePlayer",
    "GuessTheListGame",
    "GuessTheListRound",
    "GuessTheListSlot",
    "AwardDataRevision",
    "PlayerAwardSelection",
    "HigherLowerGame",
    "HigherLowerScore",
    "CareerDataRevision",
    "CareerQuizGame",
    "CareerQuizGuess",
    "CareerQuizRound",
    "PlayerCareerStint",
    "PlayerCareerSourceMapping",
    "PhotoQuizGame",
    "PhotoQuizGuess",
    "PhotoQuizRound",
    "User",
    "UserGuestId",
    "ClerkUserSyncState",
]


def __getattr__(name):
    if name in {"User", "UserGuestId", "ClerkUserSyncState"}:
        from app.models.user import ClerkUserSyncState, User, UserGuestId

        return {
            "User": User,
            "UserGuestId": UserGuestId,
            "ClerkUserSyncState": ClerkUserSyncState,
        }[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
