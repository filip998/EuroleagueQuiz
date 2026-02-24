#!/usr/bin/env python3
import sqlite3
import sys

# Connect to the database
conn = sqlite3.connect('data/euroleague.db')
cursor = conn.cursor()

# Get list of tables
print("=" * 60)
print("TABLES IN DATABASE:")
print("=" * 60)
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
tables = cursor.fetchall()
for table in tables:
    print(f"  {table[0]}")
    # Get schema for each table
    cursor.execute(f"PRAGMA table_info({table[0]});")
    columns = cursor.fetchall()
    for col in columns:
        print(f"    - {col[1]} ({col[2]})")

print("\n" + "=" * 60)
print("SEARCHING FOR PARIS TEAM AND SEASONS:")
print("=" * 60)

# Check for teams table with Paris
cursor.execute("SELECT * FROM sqlite_master WHERE type='table' AND name LIKE '%team%';")
team_tables = cursor.fetchall()
print(f"Team-related tables: {team_tables}")

# Try to find Paris
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 5;")
first_table = cursor.fetchone()
if first_table:
    print(f"\nTrying to search for 'Paris' in available tables...")

# Check seasons
cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%season%';")
season_tables = cursor.fetchall()
print(f"Season-related tables: {season_tables}")

conn.close()
print("\n" + "=" * 60)
