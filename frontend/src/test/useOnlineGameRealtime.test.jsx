import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearAuthTokenProvider, setAuthTokenProvider } from "../authToken";
import { REALTIME_CLIENT_ACTIONS, REALTIME_MESSAGE_TYPES, parseRealtimeMessage } from "../realtimeSchema";
import { useOnlineGameRealtime } from "../useOnlineGameRealtime";

function createConnector() {
  const connections = [];
  const connect = vi.fn(({ onMessage, onClose }) => {
    const connection = {
      closed: false,
      open: true,
      sent: [],
      send: vi.fn((message) => connection.sent.push(message)),
      close: vi.fn(() => {
        connection.closed = true;
        connection.open = false;
      }),
      isOpen: vi.fn(() => connection.open),
      emit: (message) => onMessage(message),
      serverClose: () => {
        connection.open = false;
        onClose();
      },
    };
    connections.push(connection);
    return connection;
  });
  return { connect, connections };
}

function RealtimeHarness({ config }) {
  const realtime = useOnlineGameRealtime(config);
  return (
    <button
      type="button"
      onClick={() => realtime.sendAction(REALTIME_CLIENT_ACTIONS.MOVE, { player_id: 7 })}
    >
      send
    </button>
  );
}

function renderHarness(overrides = {}) {
  const connector = createConnector();
  const onState = vi.fn();
  const onError = vi.fn();
  const fetchState = vi.fn().mockResolvedValue({ id: 1, status: "active" });
  const configuredFetchState = overrides.fetchState || fetchState;
  const view = render(
    <RealtimeHarness
      config={{
        enabled: true,
        gameId: 1,
        gameStatus: "active",
        playerNumber: 1,
        connect: connector.connect,
        fetchState: configuredFetchState,
        onState,
        onError,
        ...overrides,
      }}
    />
  );
  return { ...connector, onState, onError, fetchState: configuredFetchState, ...view };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  clearAuthTokenProvider();
});

describe("parseRealtimeMessage", () => {
  it("normalizes backend-owned state and error envelopes", () => {
    expect(
      parseRealtimeMessage({
        type: REALTIME_MESSAGE_TYPES.STATE,
        payload: {
          game: { id: 1, status: "active" },
          result: "round_won",
          completed_round: { round_number: 1 },
          feedback: { message: "Wrong clue." },
          terminal: false,
        },
      })
    ).toEqual({
      kind: "state",
      state: { id: 1, status: "active" },
      result: "round_won",
      completedRound: { round_number: 1 },
      feedback: { message: "Wrong clue." },
      terminal: false,
    });

    expect(
      parseRealtimeMessage({
        type: REALTIME_MESSAGE_TYPES.ERROR,
        payload: { code: "conflict", message: "It is not your turn" },
      })
    ).toEqual({
      kind: "error",
      code: "conflict",
      error: "It is not your turn",
    });
  });
});

describe("useOnlineGameRealtime", () => {
  async function flushAsyncConnect() {
    await act(async () => {
      for (let i = 0; i < 3; i += 1) {
        await Promise.resolve();
      }
    });
  }

  it("reconnects after a socket close with fake timers", () => {
    vi.useFakeTimers();
    const { connect, connections } = renderHarness();

    expect(connect).toHaveBeenCalledTimes(1);
    act(() => connections[0].serverClose());
    act(() => vi.advanceTimersByTime(1999));
    expect(connect).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("closes the connection and cancels reconnect cleanup on unmount", () => {
    vi.useFakeTimers();
    const { connect, connections, unmount } = renderHarness();

    expect(connect).toHaveBeenCalledTimes(1);
    unmount();
    expect(connections[0].close).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("ignores stale close events after reconnecting to a different game", () => {
    vi.useFakeTimers();
    const connector = createConnector();
    const baseConfig = {
      enabled: true,
      gameStatus: "active",
      playerNumber: 1,
      connect: connector.connect,
      fetchState: vi.fn().mockResolvedValue({ id: 1, status: "active" }),
      onState: vi.fn(),
      onError: vi.fn(),
    };
    const { rerender } = render(
      <RealtimeHarness config={{ ...baseConfig, gameId: 1 }} />
    );

    rerender(<RealtimeHarness config={{ ...baseConfig, gameId: 2 }} />);
    act(() => connector.connections[0].serverClose());
    act(() => vi.advanceTimersByTime(2000));

    expect(connector.connect).toHaveBeenCalledTimes(2);
    expect(connector.connections[1].closed).toBe(false);
  });

  it("ignores stale socket messages after reconnecting to a different game", () => {
    const connector = createConnector();
    const onState = vi.fn();
    const baseConfig = {
      enabled: true,
      gameStatus: "active",
      playerNumber: 1,
      connect: connector.connect,
      fetchState: vi.fn().mockResolvedValue({ id: 1, status: "active" }),
      onState,
      onError: vi.fn(),
    };
    const { rerender } = render(
      <RealtimeHarness config={{ ...baseConfig, gameId: 1 }} />
    );

    rerender(<RealtimeHarness config={{ ...baseConfig, gameId: 2 }} />);
    act(() =>
      connector.connections[0].emit({
        kind: "state",
        state: { id: 1, status: "active" },
        result: null,
        completedRound: null,
        terminal: false,
      })
    );

    expect(onState).not.toHaveBeenCalled();
  });

  it("dispatches incoming state messages and sends actions through the connector", () => {
    const { connections, onState } = renderHarness();

    act(() =>
      connections[0].emit({
        kind: "state",
        state: { id: 1, status: "active", current_player: 2 },
        result: "time_expired",
        completedRound: null,
        terminal: false,
      })
    );
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        state: { id: 1, status: "active", current_player: 2 },
        result: "time_expired",
      })
    );

    fireEvent.click(screen.getByText("send"));
    expect(connections[0].sent).toEqual([
      { action: "move", player_id: 7 },
    ]);
  });

  it("passes the auth token to the websocket connector when signed in", async () => {
    setAuthTokenProvider(async () => "session-token");

    const { connect } = renderHarness();
    expect(connect).not.toHaveBeenCalled();
    await flushAsyncConnect();

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ authToken: "session-token" })
    );
  });

  it("connects as guest when the registered token provider returns no token", async () => {
    setAuthTokenProvider(async () => null);

    const { connect } = renderHarness();
    expect(connect).not.toHaveBeenCalled();
    await flushAsyncConnect();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0].authToken).toBeUndefined();
  });

  it("reconnects with a token when the provider registers after anonymous connect", async () => {
    const { connect, connections } = renderHarness();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0].authToken).toBeUndefined();

    act(() => {
      setAuthTokenProvider(async () => "late-token");
    });
    await flushAsyncConnect();

    expect(connections[0].closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1][0].authToken).toBe("late-token");
  });

  it("reconnects as guest when the token provider is cleared", async () => {
    setAuthTokenProvider(async () => "session-token");

    const { connect, connections } = renderHarness();
    await flushAsyncConnect();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[0][0].authToken).toBe("session-token");

    await act(async () => {
      clearAuthTokenProvider();
      await Promise.resolve();
    });

    expect(connections[0].closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[1][0].authToken).toBeUndefined();
  });

  it("does not open a stale socket if unmounted while resolving the token", async () => {
    let resolveToken;
    setAuthTokenProvider(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        })
    );

    const { connect, unmount } = renderHarness();
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    await act(async () => {
      resolveToken("late-token");
      await Promise.resolve();
    });

    expect(connect).not.toHaveBeenCalled();
  });

  it("runs background polling sync for active games", async () => {
    vi.useFakeTimers();
    const { fetchState, onState } = renderHarness({
      fetchState: vi.fn().mockResolvedValue({ id: 1, status: "active", current_player: 2 }),
    });

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });

    expect(fetchState).toHaveBeenCalledWith(1);
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "poll",
        state: { id: 1, status: "active", current_player: 2 },
      })
    );
  });

  it("polls waiting-for-opponent games on the shorter sync interval", async () => {
    vi.useFakeTimers();
    const { fetchState, onState } = renderHarness({
      gameStatus: "waiting_for_opponent",
      fetchState: vi.fn().mockResolvedValue({ id: 1, status: "active" }),
    });

    await act(async () => {
      vi.advanceTimersByTime(1999);
      await Promise.resolve();
    });
    expect(fetchState).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    expect(fetchState).toHaveBeenCalledWith(1);
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "poll",
        state: { id: 1, status: "active" },
      })
    );
  });

  it("ignores stale polling responses after switching games", async () => {
    vi.useFakeTimers();
    let resolveOldRequest;
    const onState = vi.fn();
    const fetchState = vi.fn((gameId) => {
      if (gameId === 1) {
        return new Promise((resolve) => {
          resolveOldRequest = resolve;
        });
      }
      return Promise.resolve({ id: gameId, status: "active" });
    });
    const connector = createConnector();
    const baseConfig = {
      enabled: true,
      gameStatus: "active",
      playerNumber: 1,
      connect: connector.connect,
      fetchState,
      onState,
      onError: vi.fn(),
    };
    const { rerender } = render(
      <RealtimeHarness config={{ ...baseConfig, gameId: 1 }} />
    );

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    rerender(<RealtimeHarness config={{ ...baseConfig, gameId: 2 }} />);
    await act(async () => {
      resolveOldRequest({ id: 1, status: "active" });
      await Promise.resolve();
    });

    expect(onState).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: { id: 1, status: "active" } })
    );
  });

  it("ignores polling responses when realtime state arrived after the poll started", async () => {
    vi.useFakeTimers();
    let resolvePoll;
    const onState = vi.fn();
    const fetchState = vi.fn(() => new Promise((resolve) => {
      resolvePoll = resolve;
    }));
    const { connections } = renderHarness({ fetchState, onState });

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await Promise.resolve();
    });
    act(() =>
      connections[0].emit({
        kind: "state",
        state: { id: 1, status: "active", current_player: 2 },
        result: "correct",
        completedRound: null,
        terminal: false,
      })
    );
    await act(async () => {
      resolvePoll({ id: 1, status: "active", current_player: 1 });
      await Promise.resolve();
    });

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "correct",
        state: { id: 1, status: "active", current_player: 2 },
      })
    );
  });

  it("does not connect until the player identity exists", () => {
    const { connect } = renderHarness({ playerNumber: undefined });

    expect(connect).not.toHaveBeenCalled();
  });
});
