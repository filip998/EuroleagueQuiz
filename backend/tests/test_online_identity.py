import pytest

from app.game_actions import ConflictGameActionError, InvalidGameActionError
from app.models.roster_guess import RosterGuessGame
from app.models.tictactoe import QuizTicTacToeGame
from app.schemas.realtime import RealtimeClientAction
from app.services.roster_guess import (
    handle_time_expired as handle_roster_time_expired,
    offer_end,
    respond_end,
    submit_guess,
)
from app.services.tictactoe import (
    handle_time_expired as handle_tictactoe_time_expired,
    offer_draw,
    respond_draw,
    submit_move,
)
from app.services.realtime_adapters import (
    RosterGuessRealtimeAdapter,
    TicTacToeRealtimeAdapter,
)


class FlushOnlySession:
    def flush(self):
        return None


def _tictactoe_game(**overrides):
    attrs = {
        "mode": "online_friend",
        "status": "active",
        "current_player": 1,
        "pending_draw_from": None,
        "pending_draw_to": None,
    }
    attrs.update(overrides)
    return QuizTicTacToeGame(**attrs)


def _roster_game(**overrides):
    attrs = {
        "mode": "online_friend",
        "status": "active",
        "current_player": 1,
        "pending_end_from": None,
        "pending_end_to": None,
    }
    attrs.update(overrides)
    return RosterGuessGame(**attrs)


def test_tictactoe_online_move_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        submit_move(
            None,
            game=_tictactoe_game(),
            row_index=0,
            col_index=0,
            player_id=1,
        )


def test_tictactoe_online_draw_offer_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        offer_draw(None, _tictactoe_game())


def test_tictactoe_online_draw_response_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        respond_draw(
            None,
            _tictactoe_game(
                current_player=2,
                pending_draw_from=1,
                pending_draw_to=2,
            ),
            accept=False,
        )


def test_roster_online_guess_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        submit_guess(None, game=_roster_game(), player_id=1)


def test_roster_online_end_offer_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        offer_end(None, _roster_game())


def test_roster_online_end_response_requires_realtime_identity():
    with pytest.raises(ConflictGameActionError, match="realtime player identity"):
        respond_end(
            None,
            _roster_game(current_player=2, pending_end_from=1, pending_end_to=2),
            accept=False,
        )


def test_tictactoe_pending_draw_timeout_auto_declines_and_switches_turn():
    game = _tictactoe_game(
        current_player=2,
        round_number=1,
        pending_draw_from=1,
        pending_draw_to=2,
    )

    handle_tictactoe_time_expired(
        FlushOnlySession(),
        game,
        expected_player=2,
        expected_round=1,
    )

    assert game.pending_draw_from is None
    assert game.pending_draw_to is None
    assert game.current_player == 1


def test_roster_pending_end_timeout_auto_declines_and_switches_turn():
    game = _roster_game(
        current_player=2,
        round_number=1,
        pending_end_from=1,
        pending_end_to=2,
    )

    handle_roster_time_expired(
        FlushOnlySession(),
        game,
        expected_player=2,
        expected_round=1,
    )

    assert game.pending_end_from is None
    assert game.pending_end_to is None
    assert game.current_player == 1


@pytest.mark.parametrize(
    ("field", "data"),
    [
        ("row_index", {"action": "move", "col_index": 0, "player_id": 1}),
        ("col_index", {"action": "move", "row_index": 0, "player_id": 1}),
        ("player_id", {"action": "move", "row_index": 0, "col_index": 0}),
    ],
)
def test_tictactoe_realtime_move_validates_required_fields(field, data):
    with pytest.raises(InvalidGameActionError, match=field):
        TicTacToeRealtimeAdapter().handle_client_action(
            FlushOnlySession(),
            _tictactoe_game(),
            action=RealtimeClientAction.MOVE.value,
            data=data,
            player=1,
        )


def test_roster_realtime_guess_validates_required_fields():
    with pytest.raises(InvalidGameActionError, match="player_id"):
        RosterGuessRealtimeAdapter().handle_client_action(
            FlushOnlySession(),
            _roster_game(),
            action=RealtimeClientAction.GUESS.value,
            data={"action": "guess"},
            player=1,
        )


@pytest.mark.parametrize("data", [{}, {"accept": "false"}, {"accept": {}}])
def test_tictactoe_realtime_draw_response_validates_accept(data):
    with pytest.raises(InvalidGameActionError, match="accept"):
        TicTacToeRealtimeAdapter().handle_client_action(
            FlushOnlySession(),
            _tictactoe_game(
                current_player=2,
                pending_draw_from=1,
                pending_draw_to=2,
            ),
            action=RealtimeClientAction.RESPOND_DRAW.value,
            data=data,
            player=2,
        )


@pytest.mark.parametrize("data", [{}, {"accept": "false"}, {"accept": {}}])
def test_roster_realtime_end_response_validates_accept(data):
    with pytest.raises(InvalidGameActionError, match="accept"):
        RosterGuessRealtimeAdapter().handle_client_action(
            FlushOnlySession(),
            _roster_game(current_player=2, pending_end_from=1, pending_end_to=2),
            action=RealtimeClientAction.RESPOND_END.value,
            data=data,
            player=2,
        )
