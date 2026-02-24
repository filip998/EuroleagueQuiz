#!/usr/bin/env python3
import sqlite3
import sys

conn = sqlite3.connect('data/euroleague.db')
cursor = conn.cursor()

# Check seasons table
print("=== SEASONS TABLE ===")
cursor.execute("PRAGMA table_info(seasons);")
print("Schema:")
for row in cursor.fetchall():
    print(row)

print("\nData:")
cursor.execute("SELECT * FROM seasons;")
seasons = cursor.fetchall()
for row in seasons:
    print(row)

# Check what year data we have
print("\n=== CHECKING FOR 2024-25 SEASON ===")
cursor.execute("SELECT id, year FROM seasons WHERE year = 2024 OR year = 2025 OR year LIKE '%2024%';")
season_data = cursor.fetchall()
print("Matching seasons:")
for row in season_data:
    print(row)

# Get the season ID for 2024-25
season_id = None
for row in season_data:
    season_id = row[0]
    print(f"\nUsing season_id = {season_id}")
    break

if not season_id:
    print("\nNo matching season found. Let's check all seasons:")
    cursor.execute("SELECT * FROM seasons;")
    for row in cursor.fetchall():
        print(row)
    conn.close()
    sys.exit(1)

# Find FF games in the season
print("\n=== FINDING FF GAMES ===")
cursor.execute("""
    SELECT id, game_date, home_team_id, away_team_id, home_score, away_score, 
           phase, round, euroleague_gamecode
    FROM games 
    WHERE season_id = ? AND phase = 'FF'
    ORDER BY round DESC, euroleague_gamecode DESC
""", (season_id,))

ff_games = cursor.fetchall()
print(f"Found {len(ff_games)} FF games:")
for i, game in enumerate(ff_games):
    print(f"{i}: {game}")

if not ff_games:
    print("No FF games found")
    conn.close()
    sys.exit(0)

# Get the final game
final_game = ff_games[0]
game_id = final_game[0]
game_date = final_game[1]
home_team_id = final_game[2]
away_team_id = final_game[3]
home_score = final_game[4]
away_score = final_game[5]
phase = final_game[6]
round_num = final_game[7]
gamecode = final_game[8]

# Get team names
cursor.execute("SELECT id, name FROM teams WHERE id IN (?, ?)", (home_team_id, away_team_id))
team_map = {row[0]: row[1] for row in cursor.fetchall()}

home_team_name = team_map.get(home_team_id, f"Team {home_team_id}")
away_team_name = team_map.get(away_team_id, f"Team {away_team_id}")

print("\n" + "="*100)
print("FINAL FOUR FINAL GAME - 2024-25 SEASON")
print("="*100)
print(f"\n=== GAME METADATA ===")
print(f"Date:       {game_date}")
print(f"Teams:      {home_team_name} vs {away_team_name}")
print(f"Score:      {home_team_name} {home_score} - {away_score} {away_team_name}")
print(f"Game ID:    {game_id}")
print(f"Phase:      {phase}, Round: {round_num}")
print(f"Gamecode:   {gamecode}")

# Get player box scores
print("\n=== PLAYER BOX SCORES ===\n")

cursor.execute("""
    SELECT 
        t.name as team,
        COALESCE(p.first_name || ' ' || p.last_name, 'Unknown') as player_name,
        gps.is_starter,
        gps.minutes,
        gps.points,
        gps.total_rebounds,
        gps.assists,
        gps.steals,
        gps.turnovers,
        gps.pir
    FROM game_player_stats gps
    JOIN players p ON gps.player_id = p.id
    JOIN teams t ON gps.team_id = t.id
    WHERE gps.game_id = ?
    ORDER BY t.name, gps.points DESC
""", (game_id,))

box_scores = cursor.fetchall()

if not box_scores:
    print("No player statistics found for this game")
else:
    print(f"{'Team':<20} {'Player Name':<25} {'Start':<6} {'Min':<5} {'Pts':<5} {'Reb':<5} {'Ast':<5} {'Stl':<5} {'TO':<5} {'PIR':<5}")
    print("-" * 120)
    
    current_team = None
    for row in box_scores:
        team, player, starter, minutes, points, rebounds, assists, steals, turnovers, pir = row
        
        if team != current_team:
            if current_team is not None:
                print()
            current_team = team
        
        starter_str = "Yes" if starter else "No"
        
        # Handle None values
        minutes_str = str(minutes) if minutes is not None else "-"
        points_val = points if points is not None else 0
        rebounds_val = rebounds if rebounds is not None else 0
        assists_val = assists if assists is not None else 0
        steals_val = steals if steals is not None else 0
        turnovers_val = turnovers if turnovers is not None else 0
        pir_val = pir if pir is not None else 0
        
        print(f"{team:<20} {player:<25} {starter_str:<6} {minutes_str:<5} {points_val:<5} {rebounds_val:<5} {assists_val:<5} {steals_val:<5} {turnovers_val:<5} {pir_val:<5}")

print("\n" + "="*100)
conn.close()
