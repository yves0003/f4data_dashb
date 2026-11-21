import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type * as vscode from "vscode";
import { DuckDBInstance } from "@duckdb/node-api";

const execFile = promisify(execFileCallback);
const STORAGE_FOLDER = "yves0003.f4datadashb";
const LOCKS_FOLDER = "locks";
const MANIFEST_FILE = "copy-manifest.json";

export type LocalCopyMode = "off" | "auto" | "always";

export interface LocalCopyOptions {
  mode: LocalCopyMode;
  thresholdMb: number;
  keep: "session" | `days:${number}`;
}

export interface LocalCopyProgress {
  report(message: string, increment: number): void;
}

export interface NetworkDetectionOverrides {
  getDriveType?: (drive: string) => Promise<number>;
  mountTable?: string;
  mountOutput?: string;
}

export interface LocalCopyLease {
  readonly dataPath: string;
  dispose(): Promise<void>;
}

export function readLocalCopyOptions(
  configuration: Pick<vscode.WorkspaceConfiguration, "get">
): LocalCopyOptions {
  const mode = configuration.get<unknown>("localCopy", "off");
  if (mode !== "off" && mode !== "auto" && mode !== "always") {
    throw new Error("f4datadashb.localCopy must be off, auto, or always");
  }
  const thresholdMb = configuration.get<unknown>("localCopyThresholdMb", 50);
  if (typeof thresholdMb !== "number" || !Number.isFinite(thresholdMb) || thresholdMb < 0) {
    throw new Error("f4datadashb.localCopyThresholdMb must be a non-negative number");
  }
  const keepValue = configuration.get<unknown>("localCopyKeep", "days:7");
  const keep = keepValue === "session"
    ? "session"
    : typeof keepValue === "string" && /^days:\d+$/.test(keepValue)
      ? `days:${Number(keepValue.slice(5))}` as const
      : undefined;
  if (!keep) {
    throw new Error("f4datadashb.localCopyKeep must be session or days:N");
  }
  return { mode, thresholdMb, keep };
}

interface SourceFile {
  path: string;
  relativePath: string;
  size: number;
  mtimeMs: number;
}

interface CopyManifest {
  fingerprint: string;
  sourceRoot: string;
  createdAt: number;
  lastUsedAt: number;
  files: Record<string, string>;
}

interface LockFile {
  pid: number;
}

export class InsufficientCopySpaceError extends Error {
  constructor(readonly requiredBytes: number, readonly availableBytes: number) {
    super(`Local copy needs ${requiredBytes} bytes, but only ${availableBytes} bytes are available`);
    this.name = "InsufficientCopySpaceError";
  }
}

export class LocalCopyService {
  constructor(private readonly cacheRootOverride?: string) {}

  private get cacheRoot(): string {
    return this.cacheRootOverride ?? getLocalCacheRoot();
  }

  async prepare(
    dashboardPath: string,
    options: LocalCopyOptions,
    progress: LocalCopyProgress,
    token: vscode.CancellationToken
  ): Promise<LocalCopyLease | undefined> {
    if (options.mode === "off") {
      return undefined;
    }

    const manifestPath = path.join(dashboardPath, "package.json");
    const packageJson: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (isRecord(packageJson) && Object.prototype.hasOwnProperty.call(packageJson, "dataSources")) {
      return undefined;
    }

    const sourceRoot = path.join(dashboardPath, "data");
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      return undefined;
    }

    const files = scanFiles(sourceRoot);
    if (files.length === 0) {
      return undefined;
    }
    const duckDbPaths = new Set(files
      .filter((file) => [".duckdb", ".ddb"].includes(path.extname(file.path).toLowerCase()))
      .map((file) => file.path));
    const copyableFiles = files.filter((file) =>
      path.extname(file.path).toLowerCase() !== ".wal"
      || !duckDbPaths.has(file.path.slice(0, -".wal".length))
    );
    const totalBytes = copyableFiles.reduce((total, file) => total + file.size, 0);

    if (options.mode === "auto") {
      if (totalBytes < options.thresholdMb * 1024 * 1024) {
        return undefined;
      }
      if (!await isNetworkPath(sourceRoot)) {
        return undefined;
      }
    }

    fs.mkdirSync(this.cacheRoot, { recursive: true });
    const dashboardKey = createHash("sha256").update(path.resolve(dashboardPath)).digest("hex");
    const dashboardCacheRoot = path.join(this.cacheRoot, dashboardKey);
    fs.mkdirSync(dashboardCacheRoot, { recursive: true });
    const fingerprint = getSourceFingerprint(files);
    let versionRoot = path.join(dashboardCacheRoot, fingerprint);
    let cachedManifestPath = path.join(versionRoot, MANIFEST_FILE);

    if (isReusableCopy(cachedManifestPath, fingerprint, sourceRoot, copyableFiles)) {
      return this.createLease(versionRoot, path.join(versionRoot, "data"), options.keep);
    }
    if (fs.existsSync(versionRoot)) {
      if (hasLiveLocks(versionRoot)) {
        versionRoot = path.join(dashboardCacheRoot, `${fingerprint}-${randomUUID()}`);
      } else {
        fs.rmSync(versionRoot, { recursive: true, force: true });
      }
      cachedManifestPath = path.join(versionRoot, MANIFEST_FILE);
    }

    const stats = fs.statfsSync(dashboardCacheRoot);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const requiredBytes = Math.ceil(totalBytes * 1.2);
    if (availableBytes < requiredBytes) {
      throw new InsufficientCopySpaceError(requiredBytes, availableBytes);
    }

    const stageRoot = fs.mkdtempSync(path.join(dashboardCacheRoot, `${fingerprint}.partial-`));
    const destinationRoot = path.join(stageRoot, "data");
    fs.mkdirSync(destinationRoot, { recursive: true });
    const hashes: Record<string, string> = {};
    let completedBytes = 0;
    const startedAt = Date.now();
    const abortController = new AbortController();
    const cancellation = token.onCancellationRequested(() => abortController.abort());

    try {
      let reportedPercent = 0;
      for (const [index, file] of copyableFiles.entries()) {
        if (token.isCancellationRequested) {
          return undefined;
        }
        const destination = path.join(destinationRoot, file.relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const extension = path.extname(file.path).toLowerCase();
        if (extension === ".duckdb" || extension === ".ddb") {
          hashes[file.relativePath] = await snapshotDuckDb(
            file.path,
            destination,
            abortController.signal,
            file.size,
            (filePercent, rate) => {
              const percent = totalBytes === 0
                ? 100
                : Math.min(100, (completedBytes + file.size * filePercent / 100) / totalBytes * 100);
              progress.report(
                `Snapshotting ${path.basename(file.relativePath)} (${Math.round(rate)} MB/s)`,
                Math.max(0, percent - reportedPercent)
              );
              reportedPercent = percent;
            }
          );
        } else {
          hashes[file.relativePath] = await copyFileAndHash(
            file.path,
            destination,
            abortController.signal,
            file.size,
            (bytesCopied) => {
            const percent = totalBytes === 0
              ? 100
              : Math.min(100, (completedBytes + bytesCopied) / totalBytes * 100);
            const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
            const rate = (completedBytes + bytesCopied) / elapsedSeconds / (1024 * 1024);
            progress.report(
              `Copying ${path.basename(file.relativePath)} (${Math.round(rate)} MB/s)`,
              Math.max(0, percent - reportedPercent)
            );
            reportedPercent = percent;
            }
          );
        }
        const afterCopy = fs.statSync(file.path);
        if (afterCopy.size !== file.size || afterCopy.mtimeMs !== file.mtimeMs) {
          throw new Error(`Source changed while it was being copied: ${file.relativePath}`);
        }
        completedBytes += file.size;
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
        const rate = completedBytes / elapsedSeconds / (1024 * 1024);
        const percent = totalBytes === 0 ? 100 : Math.min(100, completedBytes / totalBytes * 100);
        progress.report(`${extension === ".duckdb" || extension === ".ddb" ? "Snapshotting" : "Copying"} ${path.basename(file.relativePath)} (${Math.round(rate)} MB/s)`, Math.max(0, percent - reportedPercent));
        reportedPercent = percent;
      }

      if (token.isCancellationRequested) {
        return undefined;
      }
      const currentFiles = scanFiles(sourceRoot);
      if (getSourceFingerprint(currentFiles) !== fingerprint) {
        throw new Error("The data source changed while its local copy was being prepared");
      }

      const now = Date.now();
      const manifest: CopyManifest = {
        fingerprint,
        sourceRoot,
        createdAt: now,
        lastUsedAt: now,
        files: hashes
      };
      fs.writeFileSync(cachedManifestPathFor(stageRoot), JSON.stringify(manifest), "utf8");
      fs.renameSync(stageRoot, versionRoot);
      return this.createLease(versionRoot, path.join(versionRoot, "data"), options.keep);
    } catch (error) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      throw error;
    } finally {
      cancellation.dispose();
      if (fs.existsSync(stageRoot)) {
        fs.rmSync(stageRoot, { recursive: true, force: true });
      }
    }
  }

  purge(keep: LocalCopyOptions["keep"]): number {
    if (!fs.existsSync(this.cacheRoot)) {
      return 0;
    }
    const expiration = keep === "session"
      ? Number.POSITIVE_INFINITY
      : Date.now() - Number(keep.slice("days:".length)) * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const dashboardEntry of fs.readdirSync(this.cacheRoot, { withFileTypes: true })) {
      if (!dashboardEntry.isDirectory()) {
        continue;
      }
      const dashboardRoot = path.join(this.cacheRoot, dashboardEntry.name);
      for (const versionEntry of fs.readdirSync(dashboardRoot, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) {
          continue;
        }
        const versionRoot = path.join(dashboardRoot, versionEntry.name);
        if (versionEntry.name.includes(".partial-")) {
          const age = Date.now() - fs.statSync(versionRoot).mtimeMs;
          if (age > 24 * 60 * 60 * 1000) {
            fs.rmSync(versionRoot, { recursive: true, force: true });
            removed++;
          }
          continue;
        }
        if (hasLiveLocks(versionRoot)) {
          continue;
        }
        const manifest = readCopyManifest(path.join(versionRoot, MANIFEST_FILE));
        if (!manifest || manifest.lastUsedAt <= expiration) {
          fs.rmSync(versionRoot, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  clearUnusedCopies(): number {
    if (!fs.existsSync(this.cacheRoot)) {
      return 0;
    }
    let removed = 0;
    for (const dashboardEntry of fs.readdirSync(this.cacheRoot, { withFileTypes: true })) {
      if (!dashboardEntry.isDirectory()) {
        continue;
      }
      const dashboardRoot = path.join(this.cacheRoot, dashboardEntry.name);
      for (const versionEntry of fs.readdirSync(dashboardRoot, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) {
          continue;
        }
        const versionRoot = path.join(dashboardRoot, versionEntry.name);
        if (versionEntry.name.includes(".partial-")) {
          const age = Date.now() - fs.statSync(versionRoot).mtimeMs;
          if (age > 24 * 60 * 60 * 1000) {
            fs.rmSync(versionRoot, { recursive: true, force: true });
            removed++;
          }
          continue;
        }
        if (!hasLiveLocks(versionRoot)) {
          fs.rmSync(versionRoot, { recursive: true, force: true });
          removed++;
        }
      }
    }
    return removed;
  }

  private createLease(
    versionRoot: string,
    dataPath: string,
    keep: LocalCopyOptions["keep"]
  ): LocalCopyLease {
    const locksPath = path.join(versionRoot, LOCKS_FOLDER);
    fs.mkdirSync(locksPath, { recursive: true });
    const lockPath = path.join(locksPath, `${process.pid}-${randomUUID()}.json`);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid } satisfies LockFile), { flag: "wx" });
    const manifestPath = path.join(versionRoot, MANIFEST_FILE);
    const manifest = readCopyManifest(manifestPath);
    if (!manifest) {
      fs.rmSync(lockPath, { force: true });
      throw new Error(`Local copy manifest is missing or invalid: ${manifestPath}`);
    }
    manifest.lastUsedAt = Date.now();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    let disposed = false;
    return {
      dataPath,
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        fs.rmSync(lockPath, { force: true });
        if (keep === "session" && !hasLiveLocks(versionRoot)) {
          fs.rmSync(versionRoot, { recursive: true, force: true });
        }
      }
    };
  }
}

export function getLocalCacheRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir()
): string {
  const platformPath = platform === "win32" ? path.win32 : path;
  if (platform === "win32") {
    if (!environment.LOCALAPPDATA) {
      throw new Error("LOCALAPPDATA is not defined; cannot create a non-roaming local data copy");
    }
    return platformPath.join(environment.LOCALAPPDATA, STORAGE_FOLDER, "copies");
  }
  if (platform === "darwin") {
    return platformPath.join(homeDirectory, "Library", "Caches", STORAGE_FOLDER, "copies");
  }
  return platformPath.join(environment.XDG_CACHE_HOME || platformPath.join(homeDirectory, ".cache"), STORAGE_FOLDER, "copies");
}

export function parseMountTable(contents: string): Array<{ mountPoint: string; type: string }> {
  return contents.split(/\r?\n/).flatMap((line) => {
    const fields = line.split(/\s+/);
    if (fields.length < 3) {
      return [];
    }
    return [{
      mountPoint: decodeMountField(fields[1]),
      type: fields[2]
    }];
  });
}

export function isNetworkPathByMountTable(
  targetPath: string,
  mounts: Array<{ mountPoint: string; type: string }>
): boolean {
  const resolvedPath = path.resolve(targetPath);
  const matchingMount = mounts
    .filter(({ mountPoint }) => resolvedPath === mountPoint || resolvedPath.startsWith(`${mountPoint}${path.sep}`))
    .sort((left, right) => right.mountPoint.length - left.mountPoint.length)[0];
  return matchingMount !== undefined
    && ["smbfs", "cifs", "nfs", "afpfs"].includes(matchingMount.type.toLowerCase());
}

export async function isNetworkPath(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  overrides: NetworkDetectionOverrides = {}
): Promise<boolean> {
  if (/^(?:\\\\|\/\/)/.test(targetPath)) {
    return true;
  }
  if (platform === "win32") {
    const drive = /^([a-z]):[\\/]/i.exec(path.win32.resolve(targetPath))?.[1];
    if (!drive) {
      return false;
    }
    const driveType = overrides.getDriveType
      ? await overrides.getDriveType(drive.toUpperCase())
      : await getWindowsDriveType(drive);
    return driveType === 4;
  }

  if (overrides.mountTable !== undefined) {
    return isNetworkPathByMountTable(targetPath, parseMountTable(overrides.mountTable));
  }
  if (overrides.mountOutput !== undefined) {
    return isNetworkPathByMountTable(targetPath, parseMacMountOutput(overrides.mountOutput));
  }
  if (platform === "linux") {
    try {
      return isNetworkPathByMountTable(targetPath, parseMountTable(fs.readFileSync("/proc/mounts", "utf8")));
    } catch {
      const { stdout } = await execFile("mount", [], { timeout: 5000 });
      return isNetworkPathByMountTable(targetPath, parseMacMountOutput(stdout));
    }
  }
  const { stdout } = await execFile("mount", [], { timeout: 5000 });
  return isNetworkPathByMountTable(targetPath, parseMacMountOutput(stdout));
}

async function getWindowsDriveType(drive: string): Promise<number> {
  const script = `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive.toUpperCase()}:'").DriveType`;
  const { stdout } = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 5000,
    windowsHide: true
  });
  const type = Number(stdout.trim());
  if (!Number.isInteger(type)) {
    throw new Error(`Could not determine the drive type for ${drive.toUpperCase()}:`);
  }
  return type;
}

function parseMacMountOutput(contents: string): Array<{ mountPoint: string; type: string }> {
  return contents.split(/\r?\n/).flatMap((line) => {
    const match = / on (.+) \(([^,]+)(?:,|\))/.exec(line);
    return match ? [{ mountPoint: decodeMountField(match[1]), type: match[2] }] : [];
  });
}

function scanFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        files.push({
          path: fullPath,
          relativePath: path.relative(root, fullPath),
          size: stat.size,
          mtimeMs: stat.mtimeMs
        });
      }
    }
  };
  visit(root);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function getSourceFingerprint(files: SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.relativePath}\0${file.size}\0${file.mtimeMs}\n`);
  }
  return hash.digest("hex");
}

function isReusableCopy(
  manifestPath: string,
  fingerprint: string,
  sourceRoot: string,
  files: SourceFile[]
): boolean {
  const manifest = readCopyManifest(manifestPath);
  if (!manifest || manifest.fingerprint !== fingerprint || manifest.sourceRoot !== sourceRoot) {
    return false;
  }
  return files.every((file) => {
    const destination = path.join(path.dirname(manifestPath), "data", file.relativePath);
    try {
      const stat = fs.statSync(destination);
      const expectedHash = manifest.files[file.relativePath];
      return stat.isFile()
        && typeof expectedHash === "string"
        && hashFileSync(destination) === expectedHash;
    } catch {
      return false;
    }
  });
}

function hashFileSync(filePath: string): string {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead: number;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

async function copyFileAndHash(
  source: string,
  destination: string,
  signal: AbortSignal,
  sourceSize: number,
  onBytesCopied: (bytesCopied: number) => void
): Promise<string> {
  const partialPath = `${destination}.partial`;
  const hash = createHash("sha256");
  let bytesCopied = 0;
  let lastReportAt = 0;
  const hashStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytesCopied += chunk.length;
      const now = Date.now();
      if (now - lastReportAt >= 250 || bytesCopied >= sourceSize) {
        onBytesCopied(bytesCopied);
        lastReportAt = now;
      }
      callback(null, chunk);
    }
  });
  try {
    await pipeline(
      fs.createReadStream(source),
      hashStream,
      fs.createWriteStream(partialPath, { flags: "wx" }),
      { signal }
    );
    fs.renameSync(partialPath, destination);
    return hash.digest("hex");
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  }
}

async function snapshotDuckDb(
  source: string,
  destination: string,
  signal: AbortSignal,
  sourceSize: number,
  reportProgress: (percent: number, rateMbPerSecond: number) => void
): Promise<string> {
  if (signal.aborted) {
    throw new Error("Local copy cancelled");
  }
  const partialPath = `${destination}.partial`;
  const instance = await DuckDBInstance.create(":memory:");
  let connection: Awaited<ReturnType<DuckDBInstance["connect"]>> | undefined;
  let interruptOnCancel: (() => void) | undefined;
  try {
    connection = await instance.connect();
    interruptOnCancel = (): void => connection?.interrupt();
    signal.addEventListener("abort", interruptOnCancel, { once: true });
    const attachSource = await connection.run(
      `ATTACH ${quoteString(source)} AS "snapshot_source" (READ_ONLY)`
    );
    attachSource.closeSync();
    const attachTarget = await connection.run(
      `ATTACH ${quoteString(partialPath)} AS "snapshot_target"`
    );
    attachTarget.closeSync();
    const startedAt = Date.now();
    let lastPercent = 0;
    const reporter = setInterval(() => {
      const currentPercent = connection?.progress.percentage;
      if (typeof currentPercent === "number" && Number.isFinite(currentPercent)) {
        const percent = Math.max(lastPercent, Math.min(100, currentPercent));
        if (percent > lastPercent) {
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
          reportProgress(percent, sourceSize * percent / 100 / elapsedSeconds / (1024 * 1024));
          lastPercent = percent;
        }
      }
    }, 500);
    try {
      const copy = await connection.run("COPY FROM DATABASE snapshot_source TO snapshot_target");
      copy.closeSync();
    } finally {
      clearInterval(reporter);
    }

    const tablesReader = await connection.runAndReadAll(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_catalog = 'snapshot_source' AND table_type = 'BASE TABLE' ORDER BY table_schema, table_name LIMIT 1"
    );
    const tables = tablesReader.getRowObjects();
    tablesReader.closeSync();
    if (tables.length > 0) {
      const schema = String(tables[0].table_schema);
      const table = String(tables[0].table_name);
      const sourceCount = await countRows(connection, "snapshot_source", schema, table);
      const targetCount = await countRows(connection, "snapshot_target", schema, table);
      if (sourceCount !== targetCount) {
        throw new Error(`Local DuckDB snapshot row count mismatch for ${table}`);
      }
    }
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  } finally {
    if (interruptOnCancel) {
      signal.removeEventListener("abort", interruptOnCancel);
    }
    try {
      connection?.closeSync();
    } finally {
      instance.closeSync();
    }
  }
  if (signal.aborted) {
    fs.rmSync(partialPath, { force: true });
    throw new Error("Local copy cancelled");
  }
  if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size === 0) {
    throw new Error(`DuckDB did not produce a valid snapshot for ${source}`);
  }
  fs.renameSync(partialPath, destination);
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(destination)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function countRows(
  connection: Awaited<ReturnType<DuckDBInstance["connect"]>>,
  database: string,
  schema: string,
  table: string
): Promise<string> {
  const reader = await connection.runAndReadAll(
    `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(database)}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  );
  try {
    return String(reader.getRowObjects()[0].row_count);
  } finally {
    reader.closeSync();
  }
}

function hasLiveLocks(versionRoot: string): boolean {
  const locksPath = path.join(versionRoot, LOCKS_FOLDER);
  if (!fs.existsSync(locksPath)) {
    return false;
  }
  let live = false;
  for (const lockName of fs.readdirSync(locksPath)) {
    const lockPath = path.join(locksPath, lockName);
    let lock: LockFile | undefined;
    try {
      lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockFile;
    } catch {
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    if (!Number.isInteger(lock.pid) || !isProcessAlive(lock.pid)) {
      fs.rmSync(lockPath, { force: true });
    } else {
      live = true;
    }
  }
  return live;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

function readCopyManifest(manifestPath: string): CopyManifest | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return isRecord(parsed)
      && typeof parsed.fingerprint === "string"
      && typeof parsed.sourceRoot === "string"
      && typeof parsed.createdAt === "number"
      && typeof parsed.lastUsedAt === "number"
      && isRecord(parsed.files)
      ? {
        fingerprint: parsed.fingerprint,
        sourceRoot: parsed.sourceRoot,
        createdAt: parsed.createdAt,
        lastUsedAt: parsed.lastUsedAt,
        files: parsed.files as Record<string, string>
      }
      : undefined;
  } catch {
    return undefined;
  }
}

function cachedManifestPathFor(stageRoot: string): string {
  return path.join(stageRoot, MANIFEST_FILE);
}

function decodeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
