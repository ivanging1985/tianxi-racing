/**
 * Preserve source rows whose CSV datasets do not have a normalized D1 table.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { DB } from '../lib/db.js';
import { parseCsv } from '../lib/csv.js';

export interface IngestStats {
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  filesProcessed: number;
}

export function ingestSourceCsvRows(
  db: DB,
  dataDir: string,
  sourceCommit: string | null,
): IngestStats {
  const files: string[] = [];
  const profileFile = resolve(dataDir, 'jockeys', 'jockey_profiles.csv');
  if (existsSync(profileFile)) files.push(profileFile);

  for (const dir of [
    resolve(dataDir, 'data', 'fixtures'),
    resolve(dataDir, 'jockeys', 'records'),
    resolve(dataDir, 'trainers', 'records'),
  ]) {
    if (!existsSync(dir)) continue;
    files.push(
      ...readdirSync(dir)
        .filter((file) => file.endsWith('.csv'))
        .sort()
        .map((file) => join(dir, file)),
    );
  }

  const stats: IngestStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    filesProcessed: 0,
  };
  const upsert = db.prepare(
    `INSERT INTO source_csv_rows (source_path, row_number, row_json, source_commit)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_path, row_number) DO UPDATE SET
       row_json = excluded.row_json,
       source_commit = excluded.source_commit`,
  );

  for (const file of files) {
    let rows: Array<Record<string, string>>;
    try {
      rows = parseCsv(file);
    } catch (err) {
      stats.failed++;
      console.error(`[csv_archive] failed to parse ${file}:`, err);
      continue;
    }
    stats.filesProcessed++;
    const sourcePath = relative(dataDir, file).split(sep).join('/');
    const transaction = db.transaction(() => {
      rows.forEach((row, index) => {
        try {
          upsert.run(sourcePath, index + 1, JSON.stringify(row), sourceCommit);
          stats.inserted++;
        } catch (err) {
          stats.failed++;
          console.error(`[csv_archive] failed row ${sourcePath}:${index + 1}:`, err);
        }
      });
    });
    transaction();
  }

  return stats;
}
