/**
 * Ingest the trainer code/name reference CSV.
 */
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
}

export function ingestTrainerProfiles(
  db: DB,
  csvPath: string,
  sourceCommit: string | null,
): IngestStats {
  const rows = parseCsv(csvPath);
  const stats: IngestStats = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  const upsert = db.prepare(
    `INSERT INTO trainer_profiles (trainer_code, trainer_name, source_commit, ingested_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(trainer_code) DO UPDATE SET
       trainer_name = excluded.trainer_name,
       source_commit = excluded.source_commit,
       ingested_at = datetime('now')`,
  );

  const transaction = db.transaction(() => {
    for (const row of rows) {
      const code = row['trainer_code']?.trim();
      const name = row['trainer_name']?.trim();
      if (!code || !name) {
        stats.skipped++;
        continue;
      }
      try {
        const result = upsert.run(code, name, sourceCommit);
        if (result.changes > 0) stats.inserted++;
      } catch (err) {
        stats.failed++;
        console.error(`[trainer_profiles] failed row ${code}:`, err);
      }
    }
  });
  transaction();
  return stats;
}
