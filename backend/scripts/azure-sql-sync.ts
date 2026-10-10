#!/usr/bin/env tsx
import Database from 'better-sqlite3';
import sql from 'mssql';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, resolve } from 'node:path';

type Column = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

type UniqueIndex = {
  name: string;
  columns: string[];
  partial: number;
};

type ForeignKey = {
  id: number;
  sequence: number;
  table: string;
  from: string;
  to: string | null;
};

type TableSchema = {
  name: string;
  columns: Column[];
  primaryKey: string[];
  uniqueIndexes: UniqueIndex[];
  foreignKeys: ForeignKey[];
  keyColumns: Set<string>;
};

type ManifestEntry = {
  table: string;
  file: string;
  conflictColumns: string[];
};

const MAX_SQL_PARAMETERS = 1800;
const SYNC_KEY = 'upstream_csv_commit';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function quoteIdentifier(value: string): string {
  return `[${value.replace(/]/g, ']]')}]`;
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function stableName(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 12)}`;
}

function isTextColumn(column: Column): boolean {
  const type = column.type.toUpperCase();
  return !type.includes('INT') && !type.includes('REAL') &&
    !type.includes('FLOAT') && !type.includes('DOUBLE') && !type.includes('BLOB');
}

function sqlType(column: Column, keyLength: number): string {
  const type = column.type.toUpperCase();
  if (type.includes('INT')) return 'BIGINT';
  if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) return 'FLOAT';
  if (type.includes('BLOB')) return 'VARBINARY(MAX)';
  return keyLength > 0 ? `NVARCHAR(${keyLength})` : 'NVARCHAR(MAX)';
}

function readSchema(db: Database.Database): TableSchema[] {
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
  const tables: TableSchema[] = names.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(name)})`).all() as Column[];
    const primaryKey = columns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const indexes = db.prepare(`PRAGMA index_list(${quoteSqliteIdentifier(name)})`).all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const uniqueIndexes: UniqueIndex[] = indexes.filter((index) => index.unique).map((index) => ({
      name: index.name,
      columns: (db.prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`).all() as Array<{
        name: string | null;
      }>).map((column) => column.name).filter((column): column is string => column !== null),
      partial: index.partial,
    }));
    const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteSqliteIdentifier(name)})`).all() as ForeignKey[];
    const keyColumns = new Set(primaryKey);
    for (const index of uniqueIndexes) for (const column of index.columns) keyColumns.add(column);
    for (const foreignKey of foreignKeys) keyColumns.add(foreignKey.from);
    return { name, columns, primaryKey, uniqueIndexes, foreignKeys, keyColumns };
  });

  const knownTables = new Set(tables.map((table) => table.name));
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      if (!knownTables.has(foreignKey.table)) {
        throw new Error(`${table.name} references missing source table ${foreignKey.table}`);
      }
    }
  }
  return tables;
}

async function ensureSchema(pool: sql.ConnectionPool, tables: TableSchema[]): Promise<void> {
  const keyGroups = tables.flatMap((table) => [
    table.primaryKey,
    ...table.uniqueIndexes.filter((index) => !index.partial).map((index) => index.columns),
  ].map((columns) => ({ table, columns })));
  const maxKeyTextColumns = Math.max(1, ...keyGroups.map(({ table, columns }) =>
    columns.filter((name) => {
      const column = table.columns.find((item) => item.name === name);
      return column ? isTextColumn(column) : false;
    }).length,
  ));
  const keyLength = Math.min(450, Math.max(1, Math.floor(850 / maxKeyTextColumns)));

  for (const table of tables) {
    if (!table.columns.length) continue;
    const qualified = `[dbo].${quoteIdentifier(table.name)}`;
    const columnDefinitions = table.columns.map((column) => {
      const type = sqlType(column, table.keyColumns.has(column.name) && isTextColumn(column) ? keyLength : 0);
      const nullable = column.notnull || table.primaryKey.includes(column.name) ? 'NOT NULL' : 'NULL';
      return `${quoteIdentifier(column.name)} ${type} ${nullable}`;
    });
    if (table.primaryKey.length) {
      columnDefinitions.push(
        `CONSTRAINT ${quoteIdentifier(stableName('PK', table.name))} PRIMARY KEY NONCLUSTERED (${table.primaryKey.map(quoteIdentifier).join(', ')})`,
      );
    }
    await pool.request().query(
      `IF OBJECT_ID(N'${qualified}', N'U') IS NULL BEGIN CREATE TABLE ${qualified} (${columnDefinitions.join(', ')}); END`,
    );

    const primaryKey = table.primaryKey.slice().sort().join('|');
    for (const index of table.uniqueIndexes) {
      if (index.partial || !index.columns.length || index.columns.slice().sort().join('|') === primaryKey) continue;
      const indexName = stableName('UX', `${table.name}:${index.name}`);
      const columns = index.columns.map(quoteIdentifier).join(', ');
      const filter = index.columns.map((column) => `${quoteIdentifier(column)} IS NOT NULL`).join(' AND ');
      await pool.request().query(
        `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'${qualified}') AND name = N'${indexName}') ` +
        `CREATE UNIQUE NONCLUSTERED INDEX ${quoteIdentifier(indexName)} ON ${qualified} (${columns}) WHERE ${filter};`,
      );
    }
  }

  for (const table of tables) {
    const grouped = new Map<number, ForeignKey[]>();
    for (const foreignKey of table.foreignKeys) {
      const group = grouped.get(foreignKey.id) ?? [];
      group.push(foreignKey);
      grouped.set(foreignKey.id, group);
    }
    for (const [id, keys] of grouped) {
      const first = keys[0];
      const targetColumns = first.to
        ? keys.sort((a, b) => a.sequence - b.sequence).map((key) => key.to as string)
        : tables.find((item) => item.name === first.table)?.primaryKey ?? [];
      if (targetColumns.length !== keys.length) {
        throw new Error(`Cannot map foreign key ${table.name} -> ${first.table}`);
      }
      const constraint = stableName('FK', `${table.name}:${id}:${first.table}`);
      const qualified = `[dbo].${quoteIdentifier(table.name)}`;
      const target = `[dbo].${quoteIdentifier(first.table)}`;
      await pool.request().query(
        `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N'${constraint}' AND parent_object_id = OBJECT_ID(N'${qualified}')) ` +
        `ALTER TABLE ${qualified} WITH CHECK ADD CONSTRAINT ${quoteIdentifier(constraint)} FOREIGN KEY ` +
        `(${keys.sort((a, b) => a.sequence - b.sequence).map((key) => quoteIdentifier(key.from)).join(', ')}) ` +
        `REFERENCES ${target} (${targetColumns.map(quoteIdentifier).join(', ')});`,
      );
    }
  }
}

function sqlParameterType(column: Column): sql.ISqlType {
  const type = column.type.toUpperCase();
  if (type.includes('INT')) return sql.BigInt;
  if (type.includes('REAL') || type.includes('FLOAT') || type.includes('DOUBLE')) return sql.Float;
  if (type.includes('BLOB')) return sql.VarBinary(sql.MAX);
  return sql.NVarChar(sql.MAX);
}

async function readSeedStatus(pool: sql.ConnectionPool): Promise<boolean> {
  const result = await pool.request()
    .input('syncKey', sql.NVarChar(100), SYNC_KEY)
    .query<{ value_text: string | null }>(
      'SELECT value_text FROM [dbo].[sync_state] WHERE [key] = @syncKey',
    );
  return result.recordset[0]?.value_text != null;
}

async function syncFiles(
  pool: sql.ConnectionPool,
  db: Database.Database,
  inputDir: string,
  upstreamCommit: string,
): Promise<void> {
  const manifestPath = join(inputDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestEntry[];
  const tableSchemas = new Map(readSchema(db).map((table) => [table.name, table]));

  for (const entry of manifest) {
    const schema = tableSchemas.get(entry.table);
    if (!schema) throw new Error(`No local schema found for ${entry.table}`);
    const filePath = resolve(inputDir, entry.file);
    if (!filePath.startsWith(resolve(inputDir) + '\\') && !filePath.startsWith(resolve(inputDir) + '/')) {
      throw new Error(`Invalid manifest path: ${entry.file}`);
    }
    const conflictColumns = entry.conflictColumns;
    if (!conflictColumns.length) {
      throw new Error(`${entry.table} has no primary or unique key to upsert against`);
    }
    if (conflictColumns.some((column) => !schema.columns.some((item) => item.name === column))) {
      throw new Error(`Invalid conflict columns for ${entry.table}`);
    }
    const updateColumns = schema.columns.map((column) => column.name)
      .filter((column) => !conflictColumns.includes(column));
    const rowColumns = schema.columns.map((column) => column.name);
    const rowsPerQuery = Math.floor(MAX_SQL_PARAMETERS / rowColumns.length);
    if (rowsPerQuery < 1) throw new Error(`${entry.table} has too many columns for a SQL Server request`);

    let pending: Array<Record<string, unknown>> = [];
    let imported = 0;
    const applyRows = async (rows: Array<Record<string, unknown>>) => {
      if (!rows.length) return;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        for (let start = 0; start < rows.length; start += rowsPerQuery) {
          const batch = rows.slice(start, start + rowsPerQuery);
          const request = new sql.Request(transaction);
          const values: string[] = [];
          batch.forEach((row, rowIndex) => {
            const placeholders = rowColumns.map((column, columnIndex) => {
              const name = `p${rowIndex}_${columnIndex}`;
              const metadata = schema.columns.find((item) => item.name === column);
              if (!metadata) throw new Error(`Missing column metadata: ${entry.table}.${column}`);
              request.input(name, sqlParameterType(metadata), row[column] ?? null);
              return `@${name}`;
            });
            values.push(`(${placeholders.join(', ')})`);
          });
          const sourceAlias = `source`;
          const targetAlias = `target`;
          const on = conflictColumns.map((column) =>
            `${targetAlias}.${quoteIdentifier(column)} = ${sourceAlias}.${quoteIdentifier(column)}`,
          ).join(' AND ');
          const update = updateColumns.length
            ? `WHEN MATCHED THEN UPDATE SET ${updateColumns.map((column) =>
              `${targetAlias}.${quoteIdentifier(column)} = ${sourceAlias}.${quoteIdentifier(column)}`,
            ).join(', ')} `
            : '';
          const query =
            `MERGE [dbo].${quoteIdentifier(entry.table)} WITH (HOLDLOCK) AS ${targetAlias} ` +
            `USING (VALUES ${values.join(', ')}) AS ${sourceAlias} (${rowColumns.map(quoteIdentifier).join(', ')}) ` +
            `ON ${on} ${update}WHEN NOT MATCHED BY TARGET THEN ` +
            `INSERT (${rowColumns.map(quoteIdentifier).join(', ')}) ` +
            `VALUES (${rowColumns.map((column) => `${sourceAlias}.${quoteIdentifier(column)}`).join(', ')});`;
          await request.query(query);
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
      imported += rows.length;
    };

    const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line) continue;
      pending.push(JSON.parse(line) as Record<string, unknown>);
      if (pending.length >= 200) {
        await applyRows(pending);
        pending = [];
      }
    }
    await applyRows(pending);
    console.log(`${entry.table}: ${imported} rows from ${basename(filePath)}`);
  }

  await pool.request()
    .input('syncKey', sql.NVarChar(100), SYNC_KEY)
    .input('commit', sql.NVarChar(100), upstreamCommit)
    .input('sourceCommit', sql.NVarChar(100), upstreamCommit)
    .query(
      `MERGE [dbo].[sync_state] AS target USING (SELECT @syncKey AS [key]) AS source ` +
      `ON target.[key] = source.[key] ` +
      `WHEN MATCHED THEN UPDATE SET value_text = @commit, source_commit = @sourceCommit, updated_at = CONVERT(nvarchar(30), SYSUTCDATETIME(), 126) ` +
      `WHEN NOT MATCHED THEN INSERT ([key], value_text, source_commit, updated_at) ` +
      `VALUES (@syncKey, @commit, @sourceCommit, CONVERT(nvarchar(30), SYSUTCDATETIME(), 126));`,
    );
}

async function main(): Promise<void> {
  const dbPath = resolve(process.argv.find((value) => value.startsWith('--db='))?.slice(5) ?? 'bulk-local.db');
  const inputDir = resolve(process.argv.find((value) => value.startsWith('--input-dir='))?.slice(12) ?? '');
  const upstreamCommit = process.env.UPSTREAM_SHA?.trim() ?? '';
  const statusOnly = process.argv.includes('--status');
  if (!statusOnly && !upstreamCommit) throw new Error('Set UPSTREAM_SHA to the checked-out upstream commit');

  const db = new Database(dbPath, { readonly: true });
  const tables = readSchema(db);
  const pool = await new sql.ConnectionPool({
    server: requiredEnv('AZURE_SQL_SERVER'),
    database: requiredEnv('AZURE_SQL_DATABASE'),
    user: requiredEnv('AZURE_SQL_USER'),
    password: requiredEnv('AZURE_SQL_PASSWORD'),
    options: { encrypt: true, trustServerCertificate: false },
    connectionTimeout: 30000,
    requestTimeout: 120000,
    pool: { min: 0, max: 4, idleTimeoutMillis: 30000 },
  }).connect();
  try {
    await ensureSchema(pool, tables);
    if (statusOnly) {
      console.log(`seeded=${await readSeedStatus(pool) ? 'true' : 'false'}`);
    } else {
      if (!inputDir) throw new Error('Pass --input-dir when applying an import');
      await syncFiles(pool, db, inputDir, upstreamCommit);
    }
  } finally {
    await pool.close();
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
