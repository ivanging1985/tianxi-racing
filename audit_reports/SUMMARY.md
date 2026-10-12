# Data Integrity Audit · 2026-10-12

**Overall:** 🔴 `critical`  ·  critical gaps: **11**  ·  warn gaps: 7

**Recommendation:** `gha_next_delta_will_fix`

## Per-category

| Category | Severity | Expected | Present | Missing | Stale | Notes |
|---|---|---|---|---|---|---|
| race_artefacts | 🔴 critical | 770 | 760 | 10 | 0 | days with any missing artefact: 2 |
| fixtures_cache | 🟢 ok | 1 | 231 | 0 | 0 | total cached race days: 231 |
| horse_profiles | 🟢 ok | 1185 | 1185 | 0 | 0 | total profiles in DB: 6090 |
| horse_form_records | 🟢 ok | 1185 | 1185 | 0 | 0 | total form_records files: 6090 |
| jockey_profiles | 🟢 ok | 32 | 32 | 0 | 0 | total jockey profiles: 64 |
| jockey_records | 🟡 warn | 64 | 59 | 5 | 0 | 5 jockey profiles have no records file |
| trainer_profiles | 🔴 critical | 35 | 34 | 1 | 0 | 1 trainers active recently but NO profile; total trainer profiles: 67 |
| trainer_records | 🟢 ok | 67 | 67 | 0 | 0 |  |
| trial_results | 🟢 ok | 1 | 1 | 0 | 0 | trial rows: 9327 |
| entries_upcoming | 🟡 warn | 2 | 0 | 2 | 0 | 2 upcoming race days lack entries file |

### 🔴 race_artefacts — sample missing (first 20)

```
results_2026-09-20
commentary_2026-09-20
dividends_2026-09-20
sectional_times_2026-09-20
video_links_2026-09-20
results_2026-10-11
commentary_2026-10-11
dividends_2026-10-11
sectional_times_2026-10-11
video_links_2026-10-11
```

### 🔴 trainer_profiles — sample missing (first 20)

```
甘敏斯
```
