import * as vscode from "vscode";
import {
  DashboardDocument,
  DashboardInfo,
  readStoredDashboards,
  listDashboardDocuments,
  readDashboard,
  StoredDashboardsResult
} from "./dashboardService";
import { translate } from "./i18n";

export class DashboardDocumentTreeItem extends vscode.TreeItem {
  constructor(readonly document: DashboardDocument, language: string) {
    super(document.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = document.path;
    this.contextValue = "f4datadashb.dashboardDocument";
    this.command = {
      command: "f4datadashb.openDashboardDocument",
      title: translate(language, "openDocumentAction"),
      arguments: [document.path]
    };
    this.iconPath = new vscode.ThemeIcon("file");
  }
}

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(
    readonly dashboard: DashboardInfo,
    language: string,
    favorite: boolean,
    fromFavorites = false,
    copyState?: DashboardCopyState
  ) {
    super(dashboard.displayName, vscode.TreeItemCollapsibleState.None);
    this.description = [dashboard.description, copyState?.label].filter(Boolean).join(" · ");
    this.tooltip = [
      dashboard.displayName,
      dashboard.description,
      dashboard.path,
      copyState?.tooltip
    ].filter(Boolean).join("\n");
    const baseContext = fromFavorites
      ? "f4datadashb.favoriteDashboardItem"
      : favorite
        ? "f4datadashb.dashboardFavoriteItem"
        : "f4datadashb.dashboardItem";
    const copyContext = copyState?.hasCopy
      ? `${baseContext}.hasCopy`
      : copyState?.hasData
        ? `${baseContext}.copyAvailable`
        : baseContext;
    this.contextValue = copyState?.hasDatabaseSession
      ? `${copyContext}.databaseSession`
      : copyContext;
    this.command = {
      command: "f4datadashb.openDashboard",
      title: translate(language, "openDashboardAction"),
      arguments: [dashboard.path]
    };
    this.iconPath = new vscode.ThemeIcon(!fromFavorites && favorite ? "star-full" : "screen-full");
  }
}

export interface DashboardCopyState {
  hasData: boolean;
  hasCopy: boolean;
  hasDatabaseSession?: boolean;
  label?: string;
  tooltip?: string;
}

class DashboardStatusTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    icon: string,
    contextValue: string,
    tooltip?: string,
    command?: vscode.Command
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = contextValue;
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
  }
}

export class DashboardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private dashboards: DashboardInfo[] = [];
  private readonly itemsByPath = new Map<string, DashboardTreeItem>();
  private favoritePaths = new Set<string>();
  private refreshPromise: Promise<StoredDashboardsResult> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private loading = true;
  private refreshError: string | undefined;
  private unavailablePaths: string[] = [];
  private readonly copyStates = new Map<string, DashboardCopyState>();

  constructor(private readonly state: vscode.Memento, private readonly language: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    this.itemsByPath.clear();
    const items: vscode.TreeItem[] = this.dashboards.map((dashboard) => {
      const item = new DashboardTreeItem(
        dashboard,
        this.language,
        this.favoritePaths.has(dashboard.path),
        false,
        this.copyStates.get(dashboard.path)
      );
      this.itemsByPath.set(dashboard.path, item);
      return item;
    });
    if (this.loading) {
      items.push(new DashboardStatusTreeItem(
        translate(this.language, "dashboardsLoading"),
        "loading~spin",
        "f4datadashb.dashboardLoading"
      ));
    } else if (this.refreshError) {
      items.push(new DashboardStatusTreeItem(
        translate(this.language, "dashboardsLoadFailed", this.refreshError),
        "error",
        "f4datadashb.dashboardLoadError",
        this.refreshError,
        this.refreshCommand()
      ));
    } else if (this.dashboards.length === 0 && this.unavailablePaths.length === 0) {
      items.push(new DashboardStatusTreeItem(
        translate(this.language, "dashboardsEmpty"),
        "info",
        "f4datadashb.dashboardEmpty",
        undefined,
        {
          command: "f4datadashb.importDashboard",
          title: translate(this.language, "importDashboardAction")
        }
      ));
    }
    if (this.unavailablePaths.length > 0) {
      items.push(new DashboardStatusTreeItem(
        translate(this.language, "dashboardsUnavailable", String(this.unavailablePaths.length)),
        "warning",
        "f4datadashb.dashboardUnavailable",
        this.unavailablePaths.join("\n"),
        this.refreshCommand()
      ));
    }
    return items;
  }

  setCopyState(dashboardPath: string, state: DashboardCopyState | undefined): void {
    if (state) {
      this.copyStates.set(dashboardPath, state);
    } else {
      this.copyStates.delete(dashboardPath);
    }
    this.changeEmitter.fire(undefined);
  }

  getCopyState(dashboardPath: string): DashboardCopyState | undefined {
    return this.copyStates.get(dashboardPath);
  }

  private refreshCommand(): vscode.Command {
    return {
      command: "f4datadashb.refreshDashboards",
      title: translate(this.language, "refreshDashboards")
    };
  }

  isFavorite(dashboardPath: string): boolean {
    return this.favoritePaths.has(dashboardPath);
  }

  async toggleFavorite(dashboardPath: string): Promise<void> {
    if (!this.dashboards.some((dashboard) => dashboard.path === dashboardPath)) {
      return;
    }
    if (this.favoritePaths.has(dashboardPath)) {
      this.favoritePaths.delete(dashboardPath);
    } else {
      this.favoritePaths.add(dashboardPath);
    }
    await this.state.update("favoriteDashboards", [...this.favoritePaths]);
    this.changeEmitter.fire(undefined);
  }

  async removeFavorite(dashboardPath: string): Promise<void> {
    if (!this.favoritePaths.delete(dashboardPath)) {
      return;
    }
    await this.state.update("favoriteDashboards", [...this.favoritePaths]);
    this.changeEmitter.fire(undefined);
  }

  getFavorites(): DashboardInfo[] {
    return this.dashboards.filter((dashboard) => this.favoritePaths.has(dashboard.path));
  }

  async refresh(): Promise<StoredDashboardsResult> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.clearRetryTimer();
    this.loading = true;
    this.refreshError = undefined;
    this.changeEmitter.fire(undefined);
    const refreshPromise = this.loadDashboards();
    this.refreshPromise = refreshPromise;
    try {
      return await refreshPromise;
    } catch (error) {
      this.loading = false;
      this.refreshError = error instanceof Error ? error.message : String(error);
      this.changeEmitter.fire(undefined);
      throw error;
    } finally {
      if (this.refreshPromise === refreshPromise) {
        this.refreshPromise = undefined;
      }
    }
  }

  private async loadDashboards(): Promise<StoredDashboardsResult> {
    const storedPaths = this.state.get<string[]>("dashboards", []);
    const result = readStoredDashboards(storedPaths);
    await this.state.update("dashboards", result.retainedPaths);
    const storedFavorites = this.state.get<string[]>("favoriteDashboards", []);
    const dashboardPaths = new Set(result.retainedPaths);
    const nextFavorites = new Set(storedFavorites.filter((dashboardPath) => dashboardPaths.has(dashboardPath)));
    if (nextFavorites.size !== storedFavorites.length) {
      await this.state.update("favoriteDashboards", [...nextFavorites]);
    }
    this.dashboards = result.dashboards;
    this.favoritePaths = nextFavorites;
    this.unavailablePaths = result.unavailablePaths;
    this.loading = false;
    this.refreshError = undefined;
    this.changeEmitter.fire(undefined);
    if (result.unavailableCount > 0) {
      this.scheduleRetry();
    }
    return result;
  }

  private scheduleRetry(): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.refresh().catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          translate(this.language, "importFailed", error instanceof Error ? error.message : String(error))
        );
      });
    }, 10_000);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  async add(dashboards: readonly DashboardInfo[]): Promise<number> {
    const existing = new Set(this.state.get<string[]>("dashboards", []));
    const paths = [...existing];
    let added = 0;
    for (const dashboard of dashboards) {
      if (!existing.has(dashboard.path)) {
        existing.add(dashboard.path);
        paths.push(dashboard.path);
        added++;
      }
    }
    await this.state.update("dashboards", paths);
    await this.refresh();
    return added;
  }

  async remove(dashboardPath: string): Promise<void> {
    const normalized = dashboardPath;
    const remaining = this.state.get<string[]>("dashboards", [])
      .filter((storedPath) => storedPath !== normalized);
    await this.state.update("dashboards", remaining);
    await this.refresh();
  }

  getDashboard(path: string): DashboardInfo | undefined {
    return this.dashboards.find((dashboard) => dashboard.path === path);
  }

  dispose(): void {
    this.clearRetryTimer();
    this.changeEmitter.dispose();
  }
}

export class DashboardFavoritesTreeProvider implements vscode.TreeDataProvider<DashboardTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<DashboardTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly itemsByPath = new Map<string, DashboardTreeItem>();
  private readonly favoritesChanged: vscode.Disposable;

  constructor(
    private readonly dashboards: DashboardTreeProvider,
    private readonly language: string
  ) {
    this.favoritesChanged = dashboards.onDidChangeTreeData(() => this.changeEmitter.fire(undefined));
  }

  getTreeItem(element: DashboardTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): DashboardTreeItem[] {
    this.itemsByPath.clear();
    return this.dashboards.getFavorites().map((dashboard) => {
      const item = new DashboardTreeItem(
        dashboard,
        this.language,
        true,
        true,
        this.dashboards.getCopyState(dashboard.path)
      );
      this.itemsByPath.set(dashboard.path, item);
      return item;
    });
  }

  dispose(): void {
    this.favoritesChanged.dispose();
    this.changeEmitter.dispose();
  }
}

export class DashboardDocumentsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private dashboard: DashboardInfo | undefined;
  private selectedDashboardPath: string | undefined;
  private readonly documentWatchers: vscode.Disposable[] = [];
  private documentRefreshTimer: NodeJS.Timeout | undefined;
  private readonly dashboardChanges: vscode.Disposable;

  constructor(
    private readonly language: string,
    dashboardsChanged: vscode.Event<vscode.TreeItem | undefined>
  ) {
    this.dashboardChanges = dashboardsChanged(() => {
      this.refreshSafely();
    });
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) {
      return [];
    }
    if (!this.dashboard) {
      return [];
    }
    return listDashboardDocuments(this.dashboard.path)
      .map((document) => new DashboardDocumentTreeItem(document, this.language));
  }

  setSelectedDashboard(dashboardPath: string | undefined): void {
    if (this.selectedDashboardPath === dashboardPath) {
      return;
    }
    this.selectedDashboardPath = dashboardPath;
    this.refreshSafely();
  }

  async refresh(): Promise<void> {
    let dashboard: DashboardInfo | undefined;
    if (this.selectedDashboardPath) {
      try {
        dashboard = readDashboard(this.selectedDashboardPath);
      } catch {
        dashboard = undefined;
      }
    }
    this.dashboard = dashboard;
    this.refreshDocumentWatchers();
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    if (this.documentRefreshTimer) {
      clearTimeout(this.documentRefreshTimer);
    }
    this.disposeDocumentWatchers();
    this.dashboardChanges.dispose();
    this.changeEmitter.dispose();
  }

  private refreshDocumentWatchers(): void {
    this.disposeDocumentWatchers();
    if (!this.dashboard) {
      return;
    }
    const dashboardUri = vscode.Uri.file(this.dashboard.path);
    const dashboardWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dashboardUri, "Documents")
    );
    this.documentWatchers.push(dashboardWatcher);
    this.documentWatchers.push(
      dashboardWatcher.onDidCreate(() => this.scheduleDocumentRefresh()),
      dashboardWatcher.onDidDelete(() => this.scheduleDocumentRefresh())
    );

    const documentsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dashboardUri, "Documents/*")
    );
    this.documentWatchers.push(documentsWatcher);
    this.documentWatchers.push(
      documentsWatcher.onDidCreate(() => this.scheduleDocumentRefresh()),
      documentsWatcher.onDidChange(() => this.scheduleDocumentRefresh()),
      documentsWatcher.onDidDelete(() => this.scheduleDocumentRefresh())
    );
  }

  private scheduleDocumentRefresh(): void {
    if (this.documentRefreshTimer) {
      clearTimeout(this.documentRefreshTimer);
    }
    this.documentRefreshTimer = setTimeout(() => {
      this.documentRefreshTimer = undefined;
      this.refreshSafely();
    }, 150);
  }

  private refreshSafely(): void {
    void this.refresh().catch((error: unknown) => {
      void vscode.window.showErrorMessage(
        translate(this.language, "importFailed", error instanceof Error ? error.message : String(error))
      );
    });
  }

  private disposeDocumentWatchers(): void {
    for (const subscription of this.documentWatchers.splice(0)) {
      subscription.dispose();
    }
  }
}
