import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import {
  getAuthToken,
  getAuthTokenProviderSnapshot,
  hasAuthTokenProvider,
  subscribeAuthTokenProvider,
} from "./authToken";
import { REALTIME_MESSAGE_TYPES } from "./realtimeSchema";

const DEFAULT_RECONNECT_DELAY_MS = 2000;
const DEFAULT_SYNC_INTERVAL_MS = 10000;
const DEFAULT_WAITING_SYNC_INTERVAL_MS = 2000;

export function useOnlineGameRealtime({
  enabled,
  gameId,
  gameStatus,
  playerNumber,
  connect,
  fetchState,
  onState,
  onError,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  waitingSyncIntervalMs = DEFAULT_WAITING_SYNC_INTERVAL_MS,
}) {
  const connectionRef = useRef(null);
  const realtimeVersionRef = useRef(0);
  const onStateRef = useRef(onState);
  const onErrorRef = useRef(onError);
  const authTokenProviderVersion = useSyncExternalStore(
    subscribeAuthTokenProvider,
    getAuthTokenProviderSnapshot,
    getAuthTokenProviderSnapshot
  );

  useEffect(() => {
    onStateRef.current = onState;
    onErrorRef.current = onError;
  }, [onState, onError]);

  useEffect(() => {
    const canConnect =
      enabled && gameId != null && playerNumber != null && typeof connect === "function";
    if (!canConnect) return;
    let closed = false;
    let reconnectTimeout = null;
    let activeConnection = null;
    let activeVersion = 0;

    function closeActiveConnection() {
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      const connection = activeConnection;
      activeConnection = null;
      activeVersion += 1;
      if (connectionRef.current === connection) {
        connectionRef.current = null;
      }
      connection?.close();
    }

    function scheduleReconnect(version) {
      if (closed || version !== activeVersion || reconnectTimeout) return;
      if (connectionRef.current === activeConnection) {
        connectionRef.current = null;
      }
      activeConnection = null;
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        connectNow();
      }, reconnectDelayMs);
    }

    function handleMessage(message, version) {
      if (closed || version !== activeVersion) return;
      if (message.kind === REALTIME_MESSAGE_TYPES.ERROR) {
        onErrorRef.current?.(message.error);
        return;
      }
      if (message.kind === REALTIME_MESSAGE_TYPES.STATE) {
        realtimeVersionRef.current += 1;
        onStateRef.current?.(message);
      }
    }

    function openConnection(version, authToken = null) {
      if (closed || version !== activeVersion) return;
      const options = {
        gameId,
        playerNumber,
        onMessage: (message) => handleMessage(message, version),
        onClose: () => scheduleReconnect(version),
      };
      if (authToken) options.authToken = authToken;
      activeConnection = connect(options);
      connectionRef.current = activeConnection;
    }

    async function connectWithAuthToken(version) {
      const authToken = await getAuthToken();
      openConnection(version, authToken);
    }

    function connectNow() {
      if (closed) return;
      closeActiveConnection();
      const version = activeVersion + 1;
      activeVersion = version;
      if (!hasAuthTokenProvider()) {
        openConnection(version);
        return;
      }
      void connectWithAuthToken(version);
    }

    connectNow();

    return () => {
      closed = true;
      closeActiveConnection();
    };
  }, [
    connect,
    enabled,
    gameId,
    playerNumber,
    reconnectDelayMs,
    authTokenProviderVersion,
  ]);

  useEffect(() => {
    if (!enabled || gameId == null || typeof fetchState !== "function") return;
    let closed = false;
    const intervalMs =
      gameStatus === "waiting_for_opponent"
        ? waitingSyncIntervalMs
        : syncIntervalMs;

    const interval = setInterval(async () => {
      const realtimeVersionAtStart = realtimeVersionRef.current;
      try {
        const state = await fetchState(gameId);
        if (closed || realtimeVersionAtStart !== realtimeVersionRef.current) return;
        onStateRef.current?.({
          kind: REALTIME_MESSAGE_TYPES.STATE,
          state,
          result: null,
          completedRound: null,
          terminal: state?.status === "finished",
          source: "poll",
        });
      } catch (err) {
        if (closed) return;
        onErrorRef.current?.(err.message);
      }
    }, intervalMs);

    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [
    enabled,
    fetchState,
    gameId,
    gameStatus,
    syncIntervalMs,
    waitingSyncIntervalMs,
  ]);

  const sendAction = useCallback((action, payload = {}) => {
    const connection = connectionRef.current;
    if (!connection?.isOpen?.()) return false;
    connection.send({ action, ...payload });
    return true;
  }, []);

  return { sendAction };
}
