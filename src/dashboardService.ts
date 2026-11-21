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
    .filter((entry) => entry.isFile())
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
  if (!fs.existsSync(packagePath) || !fs.statSync(packagePath).isFile()
    || !fs.existsSync(dataPath) || !fs.statSync(dataPath).isDirectory()
    || !fs.existsSync(vueIndexPath) || !fs.statSync(vueIndexPath).isFile()) {
    throw new Error("invalid-dashboard");
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(packagePath, "utf8"));
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
