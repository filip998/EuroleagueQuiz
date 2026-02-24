import { useState } from "react";
import GameSetup from "./GameSetup";
import GameBoard from "./GameBoard";

function App() {
  const [game, setGame] = useState(null);

  if (!game) {
    return <GameSetup onGameCreated={setGame} />;
  }

  return (
    <GameBoard
      initialState={game}
      onNewGame={() => setGame(null)}
    />
  );
}

export default App;
