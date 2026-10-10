/**
 * Ingest horses/profiles/horse_profiles.csv → horse_pedigree (own table)
 *
 * Why a dedicated table instead of the existing `profiles` ingest:
 *   The existing ingestHorseProfiles writes horses(id = BARE code 'A001'), which
 *   collides with UNIQUE(code) on the canonical horses rows (id = 'horse_A001'
 *   surrogate created by the results/form pipeline) → every row fails. For the
 *   LGB feature pipeline we only need a clean code→sire/dam map keyed to match
 *   race_results.horse_id directly (prefixed 'horse_'+code), so we keep our own
 *   table and never touch the horses table id convention.
 *
 * Key: horse_id = 'horse_' + horse_no  (matches race_results.horse_id)
 * Cols: 父系 (sire), 母系 (dam), 外祖父 (dam_sire / maternal grandsire)
 */
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';

export interface PedigreeStats {
  inserted: number;
  skipped: number;
  failed: number;
}

export function ingestHorsePedigree(
  db: DB,
  csvPath: string,
  sourceCommit: string | null,
): PedigreeStats {
  db.exec(`
    CREATE TABLE IF NOT EXISTS horse_pedigree (
      horse_id TEXT PRIMARY KEY REFERENCES horses(id),
      code TEXT,
      sire TEXT,
      dam TEXT,
      dam_sire TEXT,
      source_commit TEXT,
      ingested_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pedigree_sire ON horse_pedigree(sire);
    CREATE INDEX IF NOT EXISTS idx_pedigree_damsire ON horse_pedigree(dam_sire);
  `);

  const rows = parseCsv(csvPath);
  const stats: PedigreeStats = { inserted: 0, skipped: 0, failed: 0 };

  const upsert = db.prepare(
    `INSERT INTO horse_pedigree (horse_id, code, sire, dam, dam_sire, source_commit, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(horse_id) DO UPDATE SET
       sire     = COALESCE(excluded.sire, horse_pedigree.sire),
       dam      = COALESCE(excluded.dam, horse_pedigree.dam),
       dam_sire = COALESCE(excluded.dam_sire, horse_pedigree.dam_sire),
       source_commit = excluded.source_commit,
       ingested_at = datetime('now')`,
  );

  const clean = (v: string | undefined): string | null => {
    const t = (v ?? '').trim();
    return t.length ? t : null;
  };

  const tx = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      try {
        const code = (row['horse_no'] || '').trim();
        if (!code) {
          stats.skipped++;
          continue;
        }
        const sire = clean(row['父系']);
        const dam = clean(row['母系']);
        const damSire = clean(row['外祖父']);
        if (!sire && !dam && !damSire) {
          stats.skipped++;
          continue;
        }
        upsert.run(`horse_${code}`, code, sire, dam, damSire, sourceCommit);
        stats.inserted++;
      } catch (err) {
        stats.failed++;
        // eslint-disable-next-line no-console
        console.error('[horse_pedigree] failed row', row['horse_no'], err);
      }
    }
  });

  tx(rows);
  return stats;
}
