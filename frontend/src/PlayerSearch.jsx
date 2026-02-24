import { useState, useEffect, useRef } from "react";
import { autocompletePlayer } from "./api";

export default function PlayerSearch({
  rowTeamCode,
  colTeamCode,
  onSelect,
  onCancel,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (query.length < 1) {
        setResults([]);
        return;
      }
      setLoading(true);
      try {
        const data = await autocompletePlayer(
          query,
          null,
          null
        );
        setResults(data.players || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, rowTeamCode, colTeamCode]);

  function handleKeyDown(e) {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter" && results.length === 1) {
      onSelect(results[0]);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "#fff",
          padding: 24,
          borderRadius: 8,
          minWidth: 320,
          maxHeight: "80vh",
          overflow: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Search Player</h3>
        <p style={{ fontSize: 12, color: "#666" }}>
          Must have played for both{" "}
          <strong>{rowTeamCode}</strong> and{" "}
          <strong>{colTeamCode}</strong>
        </p>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type player name..."
          style={{ width: "100%", padding: 8, fontSize: 16, marginBottom: 8 }}
        />
        {loading && <p>Searching...</p>}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {results.map((p) => (
            <li
              key={p.player_id}
              onClick={() => onSelect(p)}
              style={{
                padding: "8px 4px",
                cursor: "pointer",
                borderBottom: "1px solid #eee",
              }}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = "#f0f0f0")
              }
              onMouseOut={(e) => (e.currentTarget.style.background = "")}
            >
              {p.full_name}
            </li>
          ))}
        </ul>
        {!loading && query.length >= 1 && results.length === 0 && (
          <p style={{ color: "#999" }}>No players found</p>
        )}
        <button onClick={onCancel} style={{ marginTop: 12 }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
