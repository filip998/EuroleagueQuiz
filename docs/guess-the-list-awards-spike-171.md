# Guess the List awards/champions spike (#171)

## Summary recommendation

This spike validates awards/champions as Guess the List categories, with a review-gated ingestion path for external award data. It does not add production scraper code, migrations, app code, or data artifacts.

| Category | Go/no-go | Proposed mechanic | Source reliability | Follow-up | Main risks |
|---|---:|---|---|---|---|
| All-EuroLeague Teams | Go, review-gated | Player-list round for one season. Ship First+Second Teams by default; keep First Team as a fallback/filter. | Medium-high: Wikipedia table parsed cleanly for all awarded seasons and embeds EuroLeague official refs; direct EuroLeague page fetches returned HTTP 429 from this environment. | #172 | Alias/review workload, 2006-07 six-player First Team tie, official site rate limiting. |
| Regular Season MVP | Go, with unique-winner window | `award_winners` list round: name unique MVP winners from a rolling 7-season window. | Medium-high: Wikipedia table covers the award era and embeds EuroLeague official refs; official recent MVP URL is known but returned HTTP 429 here. | #173 | Repeated winners collide with current player-unique slot model if represented as season-specific answers. |
| Final Four MVP | Go, with unique-winner window | Same `award_winners` category, metric `final_four_mvp`: name unique winners from a rolling 10-season window. | High enough with review: complete table plus official Final Four history URL; 2000-01 transition requires excluding the SuproLeague row for local EuroLeague data. | #173 | Repeat winners are common; 2019-20 not awarded. |
| Champions | Go | Champion roster list round using existing `PlayerSeasonTeam.is_champion` flags. | High internal reliability from #159/#161; no new champion scraping needed. | #174 | 2019-20 has no champion; local 2025-26 champion is curated but has 0 flagged roster slots until Final Four data is ingested. |

Recommended go/no-go gate for production follow-ups: a category should not be enabled unless every generated round candidate has accepted local `player_id`/`team_id` mappings, no unresolved ambiguous rows, source revision/provenance recorded, and at least the category minimum answer count after exclusions.

## Method and source notes

I used lightweight, non-committed probes against public pages and the tracked local SQLite DB. The parseable fallback sources were Wikipedia wikitext API pages, with revision provenance:

| Source page | Revision used by probe | URL |
|---|---:|---|
| All-EuroLeague Team | `1351163149` (2026-04-26T09:02:48Z) | https://en.wikipedia.org/wiki/All-EuroLeague_Team |
| EuroLeague MVP | `1351177038` (2026-04-26T11:58:31Z) | https://en.wikipedia.org/wiki/EuroLeague_MVP |
| EuroLeague Final Four MVP | `1358561995` (2026-06-09T13:55:45Z) | https://en.wikipedia.org/wiki/EuroLeague_Final_Four_MVP |

Representative official EuroLeague URLs found in those refs/search results:

- 2024-25 All-EuroLeague First Team: https://www.euroleaguebasketball.net/en/euroleague/news/euroleague-basketball-names-the-202425-all-euroleague-first-team/
- 2024-25 All-EuroLeague Second Team: https://www.euroleaguebasketball.net/en/euroleague/news/euroleague-basketball-announces-the-202425-all-euroleague-second-team/
- 2024-25 Regular Season MVP: https://www.euroleaguebasketball.net/en/euroleague/news/202425-turkish-airlines-euroleague-mvp-kendrick-nunn-panathinaikos-aktor-athens/
- 2025 Final Four MVP: https://www.euroleaguebasketball.net/en/euroleague/news/final-four-mvp-nigel-hayes-davis-fenerbahce-beko-istanbul/
- Official champions history: https://www.euroleaguebasketball.net/en/euroleague/news/final-four-history-every-champion-all-champions/

Direct fetches to `www.euroleaguebasketball.net` returned HTTP 429 from this environment, including the representative URLs above. Production ingestion should either use a documented, respectful official access path or treat official URLs as provenance/cross-checks while parsing the Wikipedia API fallback, consistent with the existing career/image precedent.

Local season mapping in this repo uses the season start year: source label `2024-25` maps to `seasons.year = 2024`; `2025-26` maps to `2025`.

## Coverage evidence

| Dataset | Relevant local seasons | Probe result | Gaps / edge cases |
|---|---:|---|---|
| All-EuroLeague First/Second Teams | 2000-2025, excluding canceled 2019-20 selection | 25/25 awarded seasons parsed; 251 player mentions. Every awarded season has 5 First Team and 5 Second Team selections except 2006-07, where the First Team has 6 because of a point-guard tie. | 2019-20 not awarded; 2006-07 has 11 total answers if First+Second are combined. |
| Regular Season MVP | 2004-2025 | 22/22 award-era seasons represented; 21 winners plus 2019-20 not awarded. | No award existed for 2000-2003. Repeated winners: Anthony Parker and Sasha Vezenkov. |
| Final Four MVP | 2000-2025 | 26/26 local seasons represented after excluding the 2000-01 SuproLeague duplicate; 25 winners plus 2019-20 not awarded. | 2000-01 source has both SuproLeague and ULEB EuroLeague rows; use the EuroLeague row for local data. |
| Champion rosters | 2000-2025 | Existing DB has champion teams for 25 seasons and playable `is_champion` title-squad counts for 24 seasons. Eligible champion roster sizes are 13-18 players. | 2019-20 has no champion; 2025-26 has `champion_team_id = OLY` but 0 flagged roster slots in the local DB until final data is ingested. |

Small parsed snippets from the probes:

```text
All-EuroLeague 2000-01:
First Team: Louis Bullock, Alphonso Ford, Derrick Hamilton, Gregor Fučka, Dejan Tomašević
Second Team: Jemeil Rich, Panagiotis Liadelis, Pau Gasol, Ioannis Giannoulis, Rashard Griffith

All-EuroLeague 2006-07 tie:
First Team PG cell parsed as both Theo Papaloukas and Dimitris Diamantidis.

Regular Season MVP:
2004-05 Anthony Parker; 2019-20 not awarded; 2024-25 Kendrick Nunn; 2025-26 Sasha Vezenkov.

Final Four MVP:
2000-01 EuroLeague row Manu Ginóbili; 2019-20 not awarded; 2024-25 Nigel Hayes-Davis; 2025-26 Evan Fournier.
```

## Name and team matching estimates

The strict probe used normalized exact labels against local `players`, `teams`, and `team_seasons` labels. It did not use manual aliases, source mappings, or review overrides.

| Source labels | Strict matched | Ambiguous | Unmatched | Strict rate | Review workload |
|---|---:|---:|---:|---:|---|
| All-EuroLeague player mentions | 228/251 | 3 | 20 | 90.8% | 9 unique unmatched labels plus 3 duplicate local-name choices. |
| MVP/Final Four MVP player mentions | 41/46 | 0 | 5 | 89.1% | 4 unique unmatched labels, all overlapping the All-EuroLeague alias set. |
| Team mentions | 280/298 | 0 | 18 | 94.0% | 7 unique unmatched labels. |

Unmatched player labels were mostly aliases/transliterations that exist locally under another label:

- `Theo Papaloukas` -> local `THEODOROS PAPALOUKAS`
- `Šarūnas Jasikevičius` -> local `SARAS JASIKEVICIUS`
- `Edy Tavares` -> local `WALTER TAVARES`
- `Manu Ginóbili` -> local `EMANUEL GINOBILI`
- `Ariel McDonald` -> local `ARRIEL McDONALD`
- `Jemeil Rich` -> local `JAMEIL RICH`
- `Derrick Hamilton` -> local `DERECK HAMILTON`
- `Ioannis Giannoulis` -> local `YANNIS GIANNOULIS`
- `Kšyštof Lavrinovič` -> local `KSISTOF LAVRINOVIC`

Ambiguous local player labels were `Marko Jaric`, `David Andersen`, and `Matjaz Smodis`; each has a roster-backed local row and a zero-roster duplicate. `Manu Ginobili` also has this pattern once alias-matched. Production should not auto-pick these silently: choose the roster-backed candidate only as a proposed match and require the row to be accepted or reviewed before enabling the category.

Unmatched team labels were also alias-level issues: `Kinder Bologna`, `Maccabi`, `Fenerbahce Beko`, `Olimpia Milano`, `Partizan Mobtel`, `Zenit Saint Petersburg`, and `Slask Wroclaw`. Team mappings should consider `teams.name`, `teams.short_name`, `team_seasons.team_name_that_season`, and an explicit source alias table.

## Mechanic fit

### All-EuroLeague Teams (#172)

Recommendation: ship First+Second Teams as the default category if the production review gate resolves all aliases. It gives a natural 10-answer list and matches the existing Guess the List player-slot mechanic. Keep First Team as a supported metric/filter because it gives a compact 5-answer round and is the fallback if Second Team provenance ever becomes inconsistent.

Generator shape:

- Category type: `all_euroleague_team`.
- Metric/config: `first` or `first_second`; default `first_second`.
- Round scope: one accepted award season, e.g. `2024-25 All-EuroLeague First + Second Teams`.
- Slots: accepted player selections sorted by team (`first` before `second`) and source order/position.
- Eligibility: `first` requires at least 5 accepted local players; `first_second` requires at least 10, with 2006-07 allowed to have 11 because the source explicitly records a tie.

This can plug into the existing `GuessTheListRoundGenerator` registry. It does not need a new game mode.

### MVP / awards (#173)

Recommendation: use one `award_winners` category type with metrics:

- `regular_season_mvp`: unique winners from a rolling 7-season window.
- `final_four_mvp`: unique winners from a rolling 10-season window.

The current `guess_the_list_slots` table has a unique `(round_id, player_id)` constraint, so repeated winners cannot be represented as separate season answers in one round. A unique-winner window works without a schema change to slots and still feels like a list challenge. The repeated seasons can be displayed after reveal or in `stat_value_label`, e.g. `MVP: 2022-23, 2025-26`.

Window sizing from the probe:

| Award metric | Suggested window | Unique answer range | Why |
|---|---:|---:|---|
| Regular Season MVP | 7 awarded seasons | 6-7 unique winners | 5-season windows can drop to 4 unique winners because of Anthony Parker / Sasha Vezenkov repeats; 7 keeps rounds above the roster minimum without feeling too broad. |
| Final Four MVP | 10 awarded seasons | 7-9 unique winners | Repeat winners are common; smaller windows can drop to 3-5 unique answers. |

If the product instead wants "name the MVP for each season in this window", #173 should include a slot/schema change that allows multiple answers with the same `player_id` but distinct `award_season_year` or `source_row_key`. For this spike, the lower-risk recommendation is unique winners in a window.

### Champions (#174)

Recommendation: build `champion_roster` as a Guess the List roster variant using existing #159 data:

- Category type: `champion_roster`.
- Query seasons where `seasons.champion_team_id is not null` and `PlayerSeasonTeam.is_champion = true`.
- Round scope: one champion season/team, e.g. `2024-25 Fenerbahce title roster`.
- Slots: title-squad `PlayerSeasonTeam` rows, preserving roster hints (`jersey_number`, `position`, `nationality`, height).
- Eligibility: require at least `MIN_ROSTER_SIZE` accepted slots; current local DB has 24 playable seasons with 13-18 slots each.

This should be generator work, not a new scraping project. The only data caveat is that 2025-26 is currently not playable because `PlayerSeasonTeam.is_champion` has not been populated for that season in the tracked DB.

## Proposed schema and ingestion outline

### Shared award data model for #172/#173

Use a generic award-selection model rather than one table per award:

- `award_data_revisions`
  - `id`, `source_name`, `source_url`, `source_revision_id`, `source_retrieved_at`, `content_hash`, `status`, `eligible_row_count`, `accepted_row_count`, `threshold_passed`, `report_path`, `report_hash`, `is_active`, timestamps.
- `player_award_selections`
  - `id`, `revision_id`, `award_key` (`all_euroleague_team`, `regular_season_mvp`, `final_four_mvp`), `award_metric` (`first`, `second`, `mvp`, etc.), `season_id`, `season_year`, `source_row_key`, `source_order`.
  - `source_player_label`, `source_player_url`, `local_player_id`.
  - `source_team_label`, `source_team_url`, `local_team_id`.
  - `status` (`accepted`, `unmatched`, `ambiguous`, `excluded`), `match_method`, `reviewed`, `review_note`, `candidates_json`, `error`, timestamps.
  - Unique key on `(award_key, award_metric, season_year, source_row_key)`.

This mirrors the career-source pattern: external labels are stored, local mappings are nullable until accepted, and gameplay only sees accepted rows from the active revision.

### Ingestion steps

Suggested CLI steps under `backend/ingestion/ingest.py`:

- `all-euroleague-teams` for #172.
- `player-awards` for #173, with options to include `regular-season-mvp`, `final-four-mvp`, or both.
- Reuse existing `champions` for #174; no new champion ingestion step is needed.

Implementation notes for #172/#173:

- Prefer an official EuroLeague source if a stable, respectful access path is available. Because direct EuroLeague fetches returned 429 in this spike, the safer initial parser target is the Wikipedia API wikitext page plus official EuroLeague URLs captured from refs.
- Use `settings.wikipedia_user_agent` and the existing `RateLimiter(settings.api_rate_limit_seconds)` pattern.
- Persist source revision IDs and content hashes so data changes are reviewable.
- Emit a JSON report listing accepted/unmatched/ambiguous rows, candidate local matches, and threshold status.
- Support an overrides file for known aliases, but still persist the resolved row with `reviewed`/`match_method`.
- Do not mark a revision active unless every gameplay-eligible row is accepted or intentionally excluded and each category has enough answerable rounds.

## Non-goals for this PR

- No production scraper or parser code.
- No schema migration.
- No backend/frontend app code.
- No committed parsed award/champion data artifact.
- No changes to #172, #173, #174 gating.
