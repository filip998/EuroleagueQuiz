#!/usr/bin/env python3
import sqlite3
import sys

conn = sqlite3.connect('data/euroleague.db')
cursor = conn.cursor()

# Step 1: Get table schemas
print("=== DATABASE SCHEMA ===\n")

print("Tables in database:")
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
tables = [row[0] for row in cursor.fetchall()]
print(tables)

print("\n=== GAMES TABLE SCHEMA ===")
cursor.execute("PRAGMA table_info(games);")
for row in cursor.fetchall():
    print(row)

print("\n=== GAME_PLAYER_STATS TABLE SCHEMA ===")
cursor.execute("PRAGMA table_info(game_player_stats);")
for row in cursor.fetchall():
    print(row)

print("\n=== PLAYERS TABLE SCHEMA ===")
cursor.execute("PRAGMA table_info(players);")
for row in cursor.fetchall():
    print(row)

print("\n=== TEAMS TABLE SCHEMA ===")
cursor.execute("PRAGMA table_info(teams);")
for row in cursor.fetchall():
    print(row)

# Step 2: Find Final Four games in 2024 season
print("\n\n=== FINDING FF GAMES IN 2024 SEASON ===\n")

cursor.execute("""
    SELECT id, game_date, home_team_id, away_team_id, home_score, away_score, 
           phase, round, euroleague_gamecode, season_year
    FROM games 
    WHERE season_year = 2024 AND phase = 'FF'
    ORDER BY round DESC, euroleague_gamecode DESC
    LIMIT 10
""")

ff_games = cursor.fetchall()
print(f"Found {len(ff_games)} FF games in season 2024:")
for game in ff_games:
    print(game)

if not ff_games:
    print("No FF games found in season 2024")
    conn.close()
    sys.exit(0)

# Step 3: Get the final game (first one after sorting by round DESC, gamecode DESC)
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

print(f"\n\nFINAL GAME SELECTED:")
print(f"  Game ID: {game_id}")
print(f"  Date: {game_date}")
print(f"  Home Team ID: {home_team_id}, Away Team ID: {away_team_id}")
print(f"  Score: {home_score} - {away_score}")
print(f"  Phase: {phase}, Round: {round_num}, Gamecode: {gamecode}")

# Step 4: Get team names
print("\n=== GAME METADATA ===\n")

cursor.execute("SELECT id, team_name FROM teams WHERE id IN (?, ?)", (home_team_id, away_team_id))
team_map = {row[0]: row[1] for row in cursor.fetchall()}

home_team_name = team_map.get(home_team_id, f"Team {home_team_id}")
away_team_name = team_map.get(away_team_id, f"Team {away_team_id}")

print(f"Date: {game_date}")
print(f"Teams: {home_team_name} vs {away_team_name}")
print(f"Score: {home_team_name} {home_score} - {away_score} {away_team_name}")
print(f"Game ID: {game_id}")

# Step 5: Get player box scores
print("\n=== PLAYER BOX SCORES ===\n")

cursor.execute("""
    SELECT 
        t.team_name,
        p.name,
        gps.is_starter,
        gps.minutes,
        gps.points,
        gps.rebounds,
        gps.assists,
        gps.steals,
        gps.turnovers,
        gps.pir
    FROM game_player_stats gps
    JOIN players p ON gps.player_id = p.id
    JOIN teams t ON gps.team_id = t.id
    WHERE gps.game_id = ?
    ORDER BY t.team_name, gps.points DESC
""", (game_id,))

box_scores = cursor.fetchall()

if not box_scores:
    print("No player statistics found for this game")
else:
    print(f"{'Team':<30} {'Player':<25} {'S':<2} {'Min':<4} {'Pts':<4} {'Reb':<4} {'Ast':<4} {'Stl':<4} {'TO':<4} {'PIR':<4}")
    print("-" * 130)
    
    for row in box_scores:
        team, player, starter, minutes, points, rebounds, assists, steals, turnovers, pir = row
        starter_str = "Y" if starter else "N"
        points_val = points if points is not None else 0
        rebounds_val = rebounds if rebounds is not None else 0
        assists_val = assists if assists is not None else 0
        steals_val = steals if steals is not None else 0
        turnovers_val = turnovers if turnovers is not None else 0
        pir_val = pir if pir is not None else 0
        
        print(f"{team:<30} {player:<25} {starter_str:<2} {minutes:<4} {points_val:<4} {rebounds_val:<4} {assists_val:<4} {steals_val:<4} {turnovers_val:<4} {pir_val:<4}")

conn.close()
