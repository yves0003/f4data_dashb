import * as fs from "node:fs";
import * as path from "node:path";

export interface DashboardInfo {
  path: string;
  displayName: string;
  description: string;
}

export interface DashboardDocument {
  path: string;
  name: string;
}

export interface StoredDashboardsResult {
  dashboards: DashboardInfo[];
  retainedPaths: string[];
  unavailablePaths: string[];
  invalidCount: number;
  unavailableCount: number;
}

export function listDashboardDocuments(dashboardPath: string): DashboardDocument[] {
  const documentsPath = path.join(normalizePath(dashboardPath), "Documents");
  let directoryStat: fs.Stats;
  try {
    directoryStat = fs.statSync(documentsPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  if (!directoryStat.isDirectory()) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(documentsPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name !== ".DS_Store")
    .map((entry) => ({
      name: entry.name,
      path: path.join(documentsPath, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function normalizePath(value: string): string {
  return path.normalize(path.resolve(value));
}

export function readDashboard(folder: string): DashboardInfo {
  const dashboardPath = normalizePath(folder);
  const packagePath = path.join(dashboardPath, "package.json");
  const dataPath = path.join(dashboardPath, "data");
  const vueIndexPath = path.join(dashboardPath, "vue", "index.html");
  if (!fs.statSync(dashboardPath).isDirectory()
    || !isRequiredPath(packagePath, dashboardPath, (stats) => stats.isFile())
    || !isRequiredPath(dataPath, dashboardPath, (stats) => stats.isDirectory())
    || !isRequiredPath(vueIndexPath, dashboardPath, (stats) => stats.isFile())) {
    throw new Error("invalid-dashboard");
  }

  const packageContents = fs.readFileSync(packagePath, "utf8");
  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(packageContents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("package.json must contain a JSON object");
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`invalid-package:${error instanceof Error ? error.message : String(error)}`);
  }

  const fallbackName = typeof manifest.name === "string" ? manifest.name : path.basename(dashboardPath);
  return {
    path: dashboardPath,
    displayName: stringField(manifest.displayName) ?? stringField(manifest.title) ?? fallbackName,
    description: stringField(manifest.description) ?? ""
  };
}

export function readStoredDashboards(storedPaths: readonly string[]): StoredDashboardsResult {
  const dashboards: DashboardInfo[] = [];
  const retainedPaths: string[] = [];
  const unavailablePaths: string[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  let unavailableCount = 0;

  for (const storedPath of storedPaths) {
    const normalizedPath = normalizePath(storedPath);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);

    try {
      const dashboard = readDashboard(normalizedPath);
      dashboards.push(dashboard);
      retainedPaths.push(dashboard.path);
    } catch (error) {
      if (isDashboardValidationError(error)) {
        invalidCount++;
      } else {
        unavailableCount++;
        retainedPaths.push(normalizedPath);
        unavailablePaths.push(normalizedPath);
      }
    }
  }

  return { dashboards, retainedPaths, unavailablePaths, invalidCount, unavailableCount };
}

export function isDashboardValidationError(error: unknown): boolean {
  return error instanceof Error
    && (error.message === "invalid-dashboard" || error.message.startsWith("invalid-package:"));
}

export function isDashboard(folder: string): boolean {
  try {
    readDashboard(folder);
    return true;
  } catch {
    return false;
  }
}

export function findDashboards(selectedFolders: readonly string[]): DashboardInfo[] {
  const found = new Map<string, DashboardInfo>();
  for (const folder of selectedFolders) {
    const parentPath = normalizePath(folder);
    if (isDashboard(parentPath)) {
      const dashboard = readDashboard(parentPath);
      found.set(dashboard.path, dashboard);
      continue;
    }

    if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
      continue;
    }

    for (const entry of fs.readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = normalizePath(path.join(parentPath, entry.name));
      if (isDashboard(candidate)) {
        const dashboard = readDashboard(candidate);
        found.set(dashboard.path, dashboard);
      }
    }
  }
  return [...found.values()];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRequiredPath(
  requiredPath: string,
  dashboardPath: string,
  matches: (stats: fs.Stats) => boolean
): boolean {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(requiredPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      fs.statSync(dashboardPath);
      return false;
    }
    throw error;
  }
  return matches(stats);
}
