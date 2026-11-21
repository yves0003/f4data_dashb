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

export function isRelevantDataChange(filePath: string): boolean {
  const fileName = path.basename(filePath).toLowerCase();
  if (
    fileName.startsWith("~$") ||
    /\.(?:wal|tmp|temp|partial|swp|lock)$/.test(fileName) ||
    fileName.endsWith("~")
  ) {
    return false;
  }
  return [".csv", ".tsv", ".parquet", ".duckdb", ".ddb"]
    .includes(path.extname(fileName));
}

export interface DuckDbRuntimeOptions {
  reuseInstance: boolean;
  idleReleaseSeconds: number;
  maxConcurrency: number;
}

export interface QueryOptions {
  maxRows?: number;
  signal?: AbortSignal;
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
  truncated: boolean;
  maxRows: number;
};

type CachedResult = InitialData | QueryCacheEntry;

interface ResultCacheEntry {
  fingerprint: string;
  value: CachedResult;
  bytes: number;
}

const RESULT_CACHE_MAX_BYTES = 8 * 1024 * 1024;

type DuckDbConnection = Awaited<ReturnType<DuckDBInstance["connect"]>>;

interface DatabaseSession {
  key: string;
  fingerprint: string;
  fileErrors: Map<string, string>;
  instance: DuckDBInstance;
  connections: DuckDbConnection[];
  busyConnections: Set<DuckDbConnection>;
  waiting: Array<{
    resolve(connection: DuckDbConnection): void;
    reject(error: Error): void;
  }>;
  connectionCreations: number;
  idleTimer?: NodeJS.Timeout;
  closing: boolean;
  closed: boolean;
  closePromise?: Promise<void>;
  resolveClose?: () => void;
  rejectClose?: (error: Error) => void;
}

export class DuckDbService {
  private readonly resultCache = new Map<string, ResultCacheEntry>();
  private readonly pendingOperations = new Map<string, Promise<unknown>>();
  private readonly cacheGenerations = new Map<string, number>();
  private cacheBytes = 0;
  private readonly sessions = new Map<string, DatabaseSession>();
  private readonly pendingSessions = new Map<string, Promise<DatabaseSession>>();
  private readonly dashboardReferences = new Map<string, number>();

  async loadInitialData(
    dashboardPath: string,
    force = false,
    dataRootOverride?: string,
    sessionOptions?: DuckDbRuntimeOptions,
    previewRows = 100
  ): Promise<InitialData> {
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const fingerprint = getFingerprint(files);
    const cacheKey = `${dashboardCacheKey(dashboardPath, dataRootOverride)}\0initial:${previewRows}`;
    const cached = !force ? this.getCached<InitialData>(cacheKey, fingerprint) : undefined;
    if (cached) {
      return JSON.parse(JSON.stringify(cached)) as InitialData;
    }

    const generation = this.cacheGeneration(dashboardPath);
    return this.deduplicate(cacheKey, fingerprint, async () => {
      const datasets = await this.withDatabase(files, async (connection, fileErrors) => {
        const results: DatasetResult[] = [];
        for (const file of files) {
          const setupError = fileErrors.get(file.path);
          if (setupError) {
            results.push({ name: file.name, columns: [], rows: [], error: setupError });
            continue;
          }
          try {
            if (file.type === "duckdb") {
              const tables = await readQuery(connection, "SHOW ALL TABLES");
              const alias = databaseAlias(file, files);
              const tableRows = tables.rows.filter((row) => row.database === alias);
              for (const tableRow of tableRows) {
                const tableName = typeof tableRow.name === "string" ? tableRow.name : "";
                if (tableName) {
                  const schema = typeof tableRow.schema === "string" ? tableRow.schema : "main";
                  const tablePath = `${quoteIdentifier(alias)}.${quoteIdentifier(schema)}.${quoteIdentifier(tableName)}`;
                  const columns = await readSchema(connection, tablePath);
                  const rows = previewRows > 0
                    ? (await readQuery(connection, `SELECT * FROM ${tablePath} LIMIT ${previewRows}`)).rows
                    : [];
                  results.push({
                    name: `${file.alias ? `${file.alias}: ` : `${file.name}: `}${tableName}`,
                    columns,
                    rows
                  });
                }
              }
            } else {
              const view = quoteIdentifier(viewName(file, files));
              const columns = await readSchema(connection, view);
              const rows = previewRows > 0
                ? (await readQuery(connection, `SELECT * FROM ${view} LIMIT ${previewRows}`)).rows
                : [];
              results.push({
                name: file.alias ?? file.name,
                columns,
                rows
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
      }, dashboardPath, dataRootOverride, sessionOptions);

      const data: InitialData = {
        files: files.map((file) => file.alias ? `${file.alias} (${file.name})` : file.name),
        datasets
      };
      if (this.cacheGeneration(dashboardPath) === generation) {
        this.setCached(cacheKey, fingerprint, data);
      }
      return data;
    });
  }

  async query(
    dashboardPath: string,
    sql: string,
    force = false,
    dataRootOverride?: string,
    sessionOptions?: DuckDbRuntimeOptions,
    queryOptions: QueryOptions = {}
  ): Promise<QueryCacheEntry> {
    if (
      queryOptions.maxRows !== undefined &&
      (!Number.isSafeInteger(queryOptions.maxRows) || queryOptions.maxRows < 1 || queryOptions.maxRows > 100_000)
    ) {
      throw new Error("DuckDB query maxRows must be an integer between 1 and 100000");
    }
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const fingerprint = getFingerprint(files);
    const key = `${dashboardCacheKey(dashboardPath, dataRootOverride)}\0query:${queryOptions.maxRows ?? "all"}:${sql.trim()}`;
    const cached = !force ? this.getCached<QueryCacheEntry>(key, fingerprint) : undefined;
    if (cached) {
      return cached;
    }

    const generation = this.cacheGeneration(dashboardPath);
    const executeQuery = async (): Promise<QueryCacheEntry> => {
      const result = await this.withDatabase(files, async (connection) => {
        return readQuery(connection, sql, queryOptions.maxRows, queryOptions.signal);
      }, dashboardPath, dataRootOverride, sessionOptions);
      const entry = {
        fingerprint,
        ...result,
        truncated: result.truncated === true,
        maxRows: queryOptions.maxRows ?? result.rows.length
      };
      if (!queryOptions.signal?.aborted && this.cacheGeneration(dashboardPath) === generation) {
        this.setCached(key, fingerprint, entry);
      }
      return entry;
    };
    return queryOptions.signal
      ? executeQuery()
      : this.deduplicate(key, fingerprint, executeQuery);
  }

  async invalidate(dashboardPath: string, dataRootOverride?: string): Promise<void> {
    this.cacheGenerations.set(
      path.resolve(dashboardPath),
      this.cacheGeneration(dashboardPath) + 1
    );
    if (dataRootOverride) {
      const key = dashboardCacheKey(dashboardPath, dataRootOverride);
      this.clearCached(`${key}\0`);
      this.clearPending(`${key}\0`);
      const session = this.sessions.get(key);
      if (session) {
        await this.closeSession(session);
      }
      return;
    }
    const prefix = `${path.resolve(dashboardPath)}\0`;
    this.clearCached(prefix);
    this.clearPending(prefix);
    const sessions = [...this.sessions.values()].filter((session) => session.key.startsWith(prefix));
    await Promise.all(sessions.map((session) => this.closeSession(session)));
  }

  retainDashboard(dashboardPath: string, dataRootOverride?: string): { dispose(): Promise<void> } {
    const key = dashboardCacheKey(dashboardPath, dataRootOverride);
    this.dashboardReferences.set(key, (this.dashboardReferences.get(key) ?? 0) + 1);
    let disposed = false;
    return {
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        const remaining = (this.dashboardReferences.get(key) ?? 1) - 1;
        if (remaining > 0) {
          this.dashboardReferences.set(key, remaining);
          return;
        }
        this.dashboardReferences.delete(key);
        const session = this.sessions.get(key);
        if (session) {
          await this.closeSession(session);
        }
      }
    };
  }

  async releaseDashboard(dashboardPath: string): Promise<void> {
    const prefix = `${path.resolve(dashboardPath)}\0`;
    const sessions = [...this.sessions.values()].filter((session) => session.key.startsWith(prefix));
    await Promise.all(sessions.map((session) => this.closeSession(session)));
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    await Promise.all(sessions.map((session) => this.closeSession(session)));
    this.dashboardReferences.clear();
    this.clearCached("");
    this.pendingOperations.clear();
    this.cacheGenerations.clear();
  }

  getDataWatchPatterns(dashboardPath: string, dataRootOverride?: string): DataWatchPattern[] {
    const files = resolveDataFiles(dashboardPath, dataRootOverride);
    const directories = new Set(files.map((file) => path.dirname(file.path)));
    if (files.length === 0 && !hasConfiguredDataSources(dashboardPath)) {
      directories.add(path.resolve(dataRootOverride ?? path.join(dashboardPath, "data")));
    }
    return [...directories].map((basePath) => ({ basePath, pattern: "**/*" }));
  }

  private getCached<T extends CachedResult>(key: string, fingerprint: string): T | undefined {
    const entry = this.resultCache.get(key);
    if (!entry || entry.fingerprint !== fingerprint) {
      if (entry) {
        this.deleteCached(key);
      }
      return undefined;
    }
    this.resultCache.delete(key);
    this.resultCache.set(key, entry);
    return entry.value as T;
  }

  private setCached(key: string, fingerprint: string, value: CachedResult): void {
    this.deleteCached(key);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("DuckDB result cannot be serialized for caching");
    }
    const bytes = Buffer.byteLength(key, "utf8") + Buffer.byteLength(serialized, "utf8");
    if (bytes > RESULT_CACHE_MAX_BYTES) {
      return;
    }
    while (this.cacheBytes + bytes > RESULT_CACHE_MAX_BYTES) {
      const oldestKey = this.resultCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.deleteCached(oldestKey);
    }
    this.resultCache.set(key, { fingerprint, value, bytes });
    this.cacheBytes += bytes;
  }

  private deleteCached(key: string): void {
    const entry = this.resultCache.get(key);
    if (entry) {
      this.resultCache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
  }

  private clearCached(prefix: string): void {
    for (const key of this.resultCache.keys()) {
      if (key.startsWith(prefix)) {
        this.deleteCached(key);
      }
    }
  }

  private clearPending(prefix: string): void {
    for (const key of this.pendingOperations.keys()) {
      if (key.startsWith(prefix)) {
        this.pendingOperations.delete(key);
      }
    }
  }

  private cacheGeneration(dashboardPath: string): number {
    return this.cacheGenerations.get(path.resolve(dashboardPath)) ?? 0;
  }

  private async deduplicate<T>(
    key: string,
    fingerprint: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const pendingKey = `${key}\0${fingerprint}`;
    const pending = this.pendingOperations.get(pendingKey);
    if (pending) {
      return pending as Promise<T>;
    }
    const current = operation();
    this.pendingOperations.set(pendingKey, current);
    try {
      return await current;
    } finally {
      if (this.pendingOperations.get(pendingKey) === current) {
        this.pendingOperations.delete(pendingKey);
      }
    }
  }

  private async withDatabase<T>(
    files: DataFile[],
    callback: (connection: DuckDbConnection, fileErrors: Map<string, string>) => Promise<T>,
    dashboardPath: string,
    dataRootOverride?: string,
    sessionOptions?: DuckDbRuntimeOptions
  ): Promise<T> {
    if (sessionOptions?.reuseInstance) {
      return this.withPersistentDatabase(
        files,
        callback,
        dashboardCacheKey(dashboardPath, dataRootOverride),
        sessionOptions
      );
    }
    const instance = await DuckDBInstance.create(":memory:");
    let connection: Awaited<ReturnType<DuckDBInstance["connect"]>> | undefined;
    try {
      connection = await instance.connect();
      const fileErrors = await attachFiles(connection, files);
      return await callback(connection, fileErrors);
    } finally {
      try {
        connection?.closeSync();
      } finally {
        instance.closeSync();
      }
    }
  }

  private async withPersistentDatabase<T>(
    files: DataFile[],
    callback: (connection: DuckDbConnection, fileErrors: Map<string, string>) => Promise<T>,
    key: string,
    options: DuckDbRuntimeOptions
  ): Promise<T> {
    const fingerprint = getFingerprint(files);
    const session = await this.getOrCreateSession(key, fingerprint, files);
    const connection = await this.acquireConnection(session, options.maxConcurrency);
    try {
      return await callback(connection, session.fileErrors);
    } finally {
      this.releaseConnection(session, connection, options.idleReleaseSeconds);
    }
  }

  private async getOrCreateSession(
    key: string,
    fingerprint: string,
    files: DataFile[]
  ): Promise<DatabaseSession> {
    while (true) {
      const session = this.sessions.get(key);
      if (session?.fingerprint === fingerprint && !session.closing) {
        if (session.idleTimer) {
          clearTimeout(session.idleTimer);
          session.idleTimer = undefined;
        }
        return session;
      }
      if (session) {
        await this.closeSession(session);
        continue;
      }
      const pending = this.pendingSessions.get(key);
      if (pending) {
        const pendingSession = await pending;
        if (pendingSession.fingerprint === fingerprint && !pendingSession.closing) {
          return pendingSession;
        }
        await this.closeSession(pendingSession);
        continue;
      }

      const createSession = this.createSession(key, fingerprint, files);
      this.pendingSessions.set(key, createSession);
      try {
        return await createSession;
      } finally {
        if (this.pendingSessions.get(key) === createSession) {
          this.pendingSessions.delete(key);
        }
      }
    }
  }

  private async createSession(
    key: string,
    fingerprint: string,
    files: DataFile[]
  ): Promise<DatabaseSession> {
    const instance = await DuckDBInstance.create(":memory:");
    let connection: DuckDbConnection | undefined;
    try {
      connection = await instance.connect();
      const fileErrors = await attachFiles(connection, files);
      const session: DatabaseSession = {
        key,
        fingerprint,
        fileErrors,
        instance,
        connections: [connection],
        busyConnections: new Set(),
        waiting: [],
        connectionCreations: 0,
        closing: false,
        closed: false
      };
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      try {
        connection?.closeSync();
      } finally {
        instance.closeSync();
      }
      throw error;
    }
  }

  private async acquireConnection(session: DatabaseSession, maxConcurrency: number): Promise<DuckDbConnection> {
    if (session.closing) {
      throw new Error("DuckDB dashboard session is closing");
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    const idle = session.connections.find((connection) => !session.busyConnections.has(connection));
    if (idle) {
      session.busyConnections.add(idle);
      return idle;
    }
    if (session.connections.length + session.connectionCreations < maxConcurrency) {
      session.connectionCreations++;
      try {
        const connection = await session.instance.connect();
        if (session.closing) {
          connection.closeSync();
          if (session.connectionCreations === 1 && session.busyConnections.size === 0) {
            this.finishCloseSession(session);
          }
          throw new Error("DuckDB dashboard session is closing");
        }
        session.connections.push(connection);
        session.busyConnections.add(connection);
        return connection;
      } finally {
        session.connectionCreations--;
        if (session.closing && session.connectionCreations === 0 && session.busyConnections.size === 0) {
          this.finishCloseSession(session);
        }
      }
    }
    return new Promise((resolve, reject) => session.waiting.push({ resolve, reject }));
  }

  private releaseConnection(
    session: DatabaseSession,
    connection: DuckDbConnection,
    idleReleaseSeconds: number
  ): void {
    session.busyConnections.delete(connection);
    const next = session.waiting.shift();
    if (next && !session.closing) {
      session.busyConnections.add(connection);
      next.resolve(connection);
      return;
    }
    if (session.closing && session.busyConnections.size === 0 && session.connectionCreations === 0) {
      this.finishCloseSession(session);
      return;
    }
    if (session.busyConnections.size === 0 && idleReleaseSeconds > 0) {
      session.idleTimer = setTimeout(() => {
        void this.closeSession(session);
      }, idleReleaseSeconds * 1000);
    }
  }

  private async closeSession(session: DatabaseSession): Promise<void> {
    if (session.closePromise) {
      return session.closePromise;
    }
    session.closing = true;
    session.closePromise = new Promise<void>((resolve, reject) => {
      session.resolveClose = resolve;
      session.rejectClose = reject;
    });
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    if (this.sessions.get(session.key) === session) {
      this.sessions.delete(session.key);
    }
    session.waiting.splice(0).forEach((waiter) => {
      waiter.reject(new Error("DuckDB dashboard session is closing"));
    });
    if (session.busyConnections.size === 0 && session.connectionCreations === 0) {
      this.finishCloseSession(session);
    }
    return session.closePromise;
  }

  private finishCloseSession(session: DatabaseSession): void {
    if (session.closed) {
      return;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    let closeError: unknown;
    for (const connection of session.connections) {
      try {
        connection.closeSync();
      } catch (error) {
        closeError ??= error;
      }
    }
    session.connections.length = 0;
    try {
      session.instance.closeSync();
    } catch (error) {
      closeError ??= error;
    }
    session.closed = true;
    if (closeError) {
      session.rejectClose?.(closeError instanceof Error ? closeError : new Error(String(closeError)));
    } else {
      session.resolveClose?.();
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
    return [
      file.alias ?? "",
      file.type,
      file.path,
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.birthtimeMs
    ].join(":");
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

async function attachFiles(
  connection: DuckDbConnection,
  files: DataFile[]
): Promise<Map<string, string>> {
  const fileErrors = new Map<string, string>();
  for (const file of files.filter((candidate) => candidate.type === "duckdb")) {
    try {
      const result = await connection.run(
        `ATTACH ${quoteString(file.path)} AS ${quoteIdentifier(databaseAlias(file, files))} (READ_ONLY)`
      );
      result.closeSync();
    } catch (error) {
      fileErrors.set(file.path, errorMessage(error));
    }
  }
  for (const file of files) {
    if (file.type === "duckdb") {
      continue;
    }
    try {
      const readerFunction = file.type === "parquet" ? "read_parquet" : "read_csv_auto";
      const options = file.type === "tsv" ? ", delim='\\t'" : "";
      const result = await connection.run(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(viewName(file, files))} AS SELECT * FROM ${readerFunction}(${quoteString(escapeGlob(file.path))}${options})`
      );
      result.closeSync();
    } catch (error) {
      fileErrors.set(file.path, errorMessage(error));
    }
  }
  return fileErrors;
}

async function readSchema(connection: DuckDbConnection, tableExpression: string): Promise<string[]> {
  const schema = await readQuery(connection, `DESCRIBE SELECT * FROM ${tableExpression}`);
  return schema.rows.flatMap((row) => typeof row.column_name === "string" ? [row.column_name] : []);
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
  sql: string,
  maxRows?: number,
  signal?: AbortSignal
): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  maxRows?: number;
}> {
  if (signal?.aborted) {
    throw new QueryCancelledError();
  }
  let reader: Awaited<ReturnType<typeof connection.runAndReadAll>> | undefined;
  const interrupt = (): void => connection.interrupt();
  signal?.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal?.aborted) {
      throw new QueryCancelledError();
    }
    reader = maxRows === undefined
      ? await connection.runAndReadAll(sql)
      : await connection.runAndReadUntil(sql, maxRows + 1);
    if (signal?.aborted) {
      throw new QueryCancelledError();
    }
    const rawRows = reader.getRowObjects();
    const truncated = maxRows !== undefined && (!reader.done || rawRows.length > maxRows);
    return {
      columns: reader.columnNames(),
      rows: rowsAsObjects(maxRows === undefined ? rawRows : rawRows.slice(0, maxRows)),
      ...(maxRows === undefined ? {} : { truncated, maxRows })
    };
  } catch (error) {
    if (signal?.aborted) {
      throw new QueryCancelledError();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", interrupt);
    reader?.closeSync();
  }
}

class QueryCancelledError extends Error {
  constructor() {
    super("Query cancelled");
    this.name = "QueryCancelledError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
