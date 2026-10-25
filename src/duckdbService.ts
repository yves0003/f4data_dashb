import * as fs from "node:fs";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export interface DataFile {
  name: string;
  path: string;
  type: "csv" | "tsv" | "parquet" | "duckdb";
}

export interface DatasetResult {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  error?: string;
}

export interface InitialData {
  files: string[];
  datasets: DatasetResult[];
}

type QueryCacheEntry = {
  fingerprint: string;
  rows: Record<string, unknown>[];
  columns: string[];
};

export class DuckDbService {
  private readonly cache = new Map<string, Map<string, QueryCacheEntry>>();
  private readonly initialCache = new Map<string, { fingerprint: string; data: InitialData }>();

  async loadInitialData(dashboardPath: string, force = false): Promise<InitialData> {
    const dataPath = path.join(dashboardPath, "data");
    const files = listDataFiles(dataPath);
    const fingerprint = getFingerprint(files);
    const cached = !force ? this.initialCache.get(path.resolve(dashboardPath)) : undefined;
    if (cached?.fingerprint === fingerprint) {
      return JSON.parse(JSON.stringify(cached.data)) as InitialData;
    }

    const datasets = await this.withDatabase(files, async (connection) => {
      const results: DatasetResult[] = [];
      for (const file of files) {
        try {
          if (file.type === "duckdb") {
            const tables = await readQuery(connection, "SHOW ALL TABLES");
            const alias = databaseAlias(file, files);
            const tableRows = tables.rows.filter((row) => row.database === alias);
            for (const tableRow of tableRows) {
              const tableName = typeof tableRow.name === "string" ? tableRow.name : "";
              if (tableName) {
                const schema = typeof tableRow.schema === "string" ? tableRow.schema : "main";
                const query = `SELECT * FROM ${quoteIdentifier(alias)}.${quoteIdentifier(schema)}.${quoteIdentifier(tableName)} LIMIT 100`;
                const result = await readQuery(connection, query);
                results.push({
                  name: `${file.name}: ${tableName}`,
                  columns: result.columns,
                  rows: result.rows
                });
              }
            }
          } else {
            const result = await readQuery(connection,
              `SELECT * FROM ${quoteIdentifier(viewName(file, files))} LIMIT 100`
            );
            results.push({
              name: file.name,
              columns: result.columns,
              rows: result.rows
            });
          }
        } catch (error) {
          results.push({
            name: file.name,
            columns: [],
            rows: [],
            error: errorMessage(error)
          });
        }
      }
      return results;
    });

    const data: InitialData = { files: files.map((file) => file.name), datasets };
    this.initialCache.set(path.resolve(dashboardPath), { fingerprint, data });
    return data;
  }

  async query(dashboardPath: string, sql: string, force = false): Promise<QueryCacheEntry> {
    const files = listDataFiles(path.join(dashboardPath, "data"));
    const fingerprint = getFingerprint(files);
    const cache = this.dashboardCache(dashboardPath);
    const key = sql.trim();
    const cached = !force ? cache.get(key) : undefined;
    if (cached?.fingerprint === fingerprint) {
      return cached;
    }

    const result = await this.withDatabase(files, async (connection) => {
      return readQuery(connection, sql);
    });
    cache.set(key, { fingerprint, ...result });
    while (cache.size > 20) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      cache.delete(oldestKey);
    }
    return { fingerprint, ...result };
  }

  invalidate(dashboardPath: string): void {
    const key = path.resolve(dashboardPath);
    this.cache.delete(key);
    this.initialCache.delete(key);
  }

  private dashboardCache(dashboardPath: string): Map<string, QueryCacheEntry> {
    const key = path.resolve(dashboardPath);
    let cache = this.cache.get(key);
    if (!cache) {
      cache = new Map();
      this.cache.set(key, cache);
    }
    return cache;
  }

  private async withDatabase<T>(
    files: DataFile[],
    callback: (connection: Awaited<ReturnType<DuckDBInstance["connect"]>>) => Promise<T>
  ): Promise<T> {
    const instance = await DuckDBInstance.create(":memory:");
    let connection: Awaited<ReturnType<DuckDBInstance["connect"]>> | undefined;
    try {
      connection = await instance.connect();
      for (const file of files.filter((candidate) => candidate.type === "duckdb")) {
        const result = await connection.run(
          `ATTACH ${quoteString(file.path)} AS ${quoteIdentifier(databaseAlias(file, files))} (READ_ONLY)`
        );
        result.closeSync();
      }
      for (const file of files) {
        if (file.type === "duckdb") {
          continue;
        }
        const readerFunction = file.type === "parquet" ? "read_parquet" : "read_csv_auto";
        const options = file.type === "tsv" ? ", delim='\\t'" : "";
        const result = await connection.run(
          `CREATE OR REPLACE VIEW ${quoteIdentifier(viewName(file, files))} AS SELECT * FROM ${readerFunction}(${quoteString(file.path)}${options})`
        );
        result.closeSync();
      }
      return await callback(connection);
    } finally {
      try {
        connection?.closeSync();
      } finally {
        instance.closeSync();
      }
    }
  }
}

function listDataFiles(dataPath: string): DataFile[] {
  return fs.readdirSync(dataPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry): DataFile[] => {
      const extension = path.extname(entry.name).toLowerCase();
      const type = extension === ".csv" ? "csv"
        : extension === ".tsv" ? "tsv"
          : extension === ".parquet" ? "parquet"
            : extension === ".duckdb" || extension === ".ddb" ? "duckdb"
              : undefined;
      if (!type) {
        return [];
      }
      const fullPath = path.resolve(dataPath, entry.name);
      return [{
        name: entry.name,
        path: fullPath,
        type
      }];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getFingerprint(files: DataFile[]): string {
  return files.map((file) => {
    const stat = fs.statSync(file.path);
    return `${file.path}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
}

function viewName(file: DataFile, files: DataFile[]): string {
  const stem = path.basename(file.name, path.extname(file.name));
  return `data_${files.indexOf(file)}_${stem.replace(/[^a-zA-Z0-9_]/g, "_")}_${file.type}`;
}

function databaseAlias(file: DataFile, files: DataFile[]): string {
  return `db_${files.indexOf(file)}_${path.basename(file.name, path.extname(file.name)).replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/\\/g, "/").replace(/'/g, "''")}'`;
}

function rowsAsObjects(rows: object[]): Record<string, unknown>[] {
  return rows.map((row) => JSON.parse(JSON.stringify(row, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  )) as Record<string, unknown>);
}

async function readQuery(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  sql: string
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  const reader = await connection.runAndReadAll(sql);
  try {
    return {
      columns: reader.columnNames(),
      rows: rowsAsObjects(reader.getRowObjects())
    };
  } finally {
    reader.closeSync();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
