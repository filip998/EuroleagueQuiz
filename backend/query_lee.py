import sqlite3

c = sqlite3.connect('data/euroleague.db').cursor()

# Search for Saben Lee
c.execute('SELECT p.id, p.first_name, p.last_name, p.euroleague_code FROM players p WHERE p.last_name LIKE "%LEE%"')
print('Players matching LEE:')
for r in c.fetchall():
    print(r)

# Get all PST records for Lee
c.execute('''SELECT p.first_name, p.last_name, t.name, s.year, pst.registration_start, pst.registration_end, pst.jersey_number
FROM player_season_teams pst
JOIN players p ON p.id = pst.player_id
JOIN teams t ON t.id = pst.team_id
JOIN seasons s ON s.id = pst.season_id
WHERE p.last_name LIKE "%LEE%" AND p.first_name LIKE "%SABEN%"
ORDER BY s.year, pst.registration_start''')
print('Saben Lee records:')
for r in c.fetchall():
    print(r)
