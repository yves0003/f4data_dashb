import * as fs from "node:fs";
import * as path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export interface DataFile {
  name: string;
  path: string;
  type: "csv" | "tsv" | "parquet" | "duckdb";
  alias?: string;
}

export interface DataWatchPattern {
  basePath: string;
  pattern: string;
}

interface DataSourceConfig {
  name: string;
  path: string;
  type: DataFile["type"];
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

  async loadInitialData(
    dashboardPath: string,
    force = false,
    dataRootOverride?: string
  ): Promise<InitialData> {
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const fingerprint = getFingerprint(files);
    const cacheKey = dashboardCacheKey(dashboardPath, dataRootOverride);
    const cached = !force ? this.initialCache.get(cacheKey) : undefined;
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
                  name: `${file.alias ? `${file.alias}: ` : `${file.name}: `}${tableName}`,
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
              name: file.alias ?? file.name,
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

    const data: InitialData = {
      files: files.map((file) => file.alias ? `${file.alias} (${file.name})` : file.name),
      datasets
    };
    this.initialCache.set(cacheKey, { fingerprint, data });
    return data;
  }

  async query(
    dashboardPath: string,
    sql: string,
    force = false,
    dataRootOverride?: string
  ): Promise<QueryCacheEntry> {
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const fingerprint = getFingerprint(files);
    const cache = this.dashboardCache(dashboardPath, dataRootOverride);
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

  invalidate(dashboardPath: string, dataRootOverride?: string): void {
    if (dataRootOverride) {
      const key = dashboardCacheKey(dashboardPath, dataRootOverride);
      this.cache.delete(key);
      this.initialCache.delete(key);
      return;
    }
    const prefix = `${path.resolve(dashboardPath)}\0`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    for (const key of this.initialCache.keys()) {
      if (key.startsWith(prefix)) {
        this.initialCache.delete(key);
      }
    }
  }

  getDataWatchPatterns(dashboardPath: string, dataRootOverride?: string): DataWatchPattern[] {
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const directories = new Set(files.map((file) => path.dirname(file.path)));
    if (files.length === 0 && !hasConfiguredDataSources(dashboardPath)) {
      directories.add(path.resolve(dataRootOverride ?? path.join(dashboardPath, "data")));
    }
    return [...directories].map((basePath) => ({ basePath, pattern: "**/*" }));
  }

  private dashboardCache(dashboardPath: string, dataRootOverride?: string): Map<string, QueryCacheEntry> {
    const key = dashboardCacheKey(dashboardPath, dataRootOverride);
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
          `CREATE OR REPLACE VIEW ${quoteIdentifier(viewName(file, files))} AS SELECT * FROM ${readerFunction}(${quoteString(escapeGlob(file.path))}${options})`
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

function dashboardCacheKey(dashboardPath: string, dataRootOverride?: string): string {
  return `${path.resolve(dashboardPath)}\0${dataRootOverride ? path.resolve(dataRootOverride) : ""}`;
}

function resolveDataFiles(dashboardPath: string, dataRootOverride?: string): DataFile[] {
  const resolvedDashboardPath = path.resolve(dashboardPath);
  const manifestPath = path.join(resolvedDashboardPath, "package.json");
  const parsedManifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsedManifest !== "object" || parsedManifest === null || Array.isArray(parsedManifest)) {
    throw new Error("Dashboard package.json must contain a JSON object");
  }
  const manifest = parsedManifest as Record<string, unknown>;

  if (!Object.prototype.hasOwnProperty.call(manifest, "dataSources")) {
    return listDataFiles(dataRootOverride ?? path.join(resolvedDashboardPath, "data"));
  }

  if (!Array.isArray(manifest.dataSources)) {
    throw new Error("package.json dataSources must be an array");
  }

  const sources = manifest.dataSources.map(parseDataSource);
  const sourceNames = new Set<string>();
  const files: DataFile[] = [];

  for (const source of sources) {
    if (sourceNames.has(source.name)) {
      throw new Error(`Duplicate data source name "${source.name}"`);
    }
    sourceNames.add(source.name);

    const sourcePath = normalizeSourcePath(resolvedDashboardPath, source.path);
    const stat = fs.statSync(sourcePath);
    const matchingFiles = stat.isDirectory()
      ? fs.readdirSync(sourcePath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && matchesType(entry.name, source.type))
        .map((entry) => path.resolve(sourcePath, entry.name))
        .sort((left, right) => left.localeCompare(right))
      : stat.isFile() && matchesType(sourcePath, source.type)
        ? [sourcePath]
        : [];

    if (matchingFiles.length === 0) {
      throw new Error(`Data source "${source.name}" has no ${source.type} files at "${sourcePath}"`);
    }

    for (const filePath of matchingFiles) {
      const fileName = path.basename(filePath);
      const sourceAlias = stat.isDirectory()
        ? `${source.name}_${path.basename(fileName, path.extname(fileName))}`
        : source.name;
      files.push({
        name: fileName,
        path: filePath,
        type: source.type,
        alias: sourceAlias
      });
    }
  }

  const aliases = new Set<string>();
  for (const file of files) {
    const alias = file.alias ?? file.name;
    if (aliases.has(alias)) {
      throw new Error(`Duplicate data source alias "${alias}"`);
    }
    aliases.add(alias);
  }
  return files;
}

function hasConfiguredDataSources(dashboardPath: string): boolean {
  const manifestPath = path.join(path.resolve(dashboardPath), "package.json");
  const parsedManifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsedManifest !== "object" || parsedManifest === null || Array.isArray(parsedManifest)) {
    throw new Error("Dashboard package.json must contain a JSON object");
  }
  return Object.prototype.hasOwnProperty.call(parsedManifest, "dataSources");
}

function parseDataSource(value: unknown): DataSourceConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Each package.json dataSources entry must be an object");
  }
  const source = value as Record<string, unknown>;
  if (typeof source.name !== "string" || !source.name.trim()) {
    throw new Error("Each package.json dataSources entry needs a non-empty name");
  }
  if (typeof source.path !== "string" || !source.path.trim()) {
    throw new Error(`Data source "${source.name}" needs a non-empty path`);
  }
  if (source.type !== "csv" && source.type !== "tsv" && source.type !== "parquet" && source.type !== "duckdb") {
    throw new Error(`Data source "${source.name}" has an unsupported type`);
  }
  return {
    name: source.name.trim(),
    path: source.path.trim(),
    type: source.type
  };
}

function normalizeSourcePath(dashboardPath: string, sourcePath: string): string {
  return path.normalize(path.isAbsolute(sourcePath)
    ? path.resolve(sourcePath)
    : path.resolve(dashboardPath, sourcePath));
}

function matchesType(filePath: string, type: DataFile["type"]): boolean {
  const extension = path.extname(filePath).toLowerCase();
  switch (type) {
    case "csv":
      return extension === ".csv";
    case "tsv":
      return extension === ".tsv";
    case "parquet":
      return extension === ".parquet";
    case "duckdb":
      return extension === ".duckdb" || extension === ".ddb";
  }
}

function getFingerprint(files: DataFile[]): string {
  return files.map((file) => {
    const stat = fs.statSync(file.path);
    return `${file.alias ?? ""}:${file.type}:${file.path}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
}

function viewName(file: DataFile, files: DataFile[]): string {
  if (file.alias) {
    return file.alias;
  }
  const stem = path.basename(file.name, path.extname(file.name));
  return `data_${files.indexOf(file)}_${stem.replace(/[^a-zA-Z0-9_]/g, "_")}_${file.type}`;
}

function databaseAlias(file: DataFile, files: DataFile[]): string {
  if (file.alias) {
    return file.alias;
  }
  return `db_${files.indexOf(file)}_${path.basename(file.name, path.extname(file.name)).replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  // A backslash is a separator on Windows only: it is a legal filename character elsewhere.
  const normalized = path.sep === "\\" ? value.replace(/\\/g, "/") : value;
  return `'${normalized.replace(/'/g, "''")}'`;
}

// read_csv_auto and read_parquet expand glob patterns, unlike ATTACH.
function escapeGlob(value: string): string {
  return value.replace(/[[*?]/g, (character) => `[${character}]`);
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
