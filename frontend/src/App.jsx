import { useState } from "react";
import GameSetup from "./GameSetup";
import GameBoard from "./GameBoard";

function App() {
  const [game, setGame] = useState(null);
  const [onlineInfo, setOnlineInfo] = useState(null);

  function handleGameCreated(gameResp, online) {
    setGame(gameResp);
    setOnlineInfo(online || null);
  }

  if (!game) {
    return <GameSetup onGameCreated={handleGameCreated} />;
  }

  return (
    <GameBoard
      initialState={game}
      onNewGame={() => { setGame(null); setOnlineInfo(null); }}
      onlineInfo={onlineInfo}
    />
  );
}

export default App;
