import * as vscode from "vscode";
import {
  DashboardDocument,
  DashboardInfo,
  listDashboardDocuments,
  readDashboard
} from "./dashboardService";
import { translate } from "./i18n";

export class DashboardDocumentsTreeItem extends vscode.TreeItem {
  constructor(readonly dashboard: DashboardInfo, readonly documents: DashboardDocument[]) {
    super(dashboard.displayName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = dashboard.path;
    this.tooltip = dashboard.path;
    this.contextValue = "f4datadashb.dashboardDocuments";
    this.iconPath = new vscode.ThemeIcon("folder");
  }
}

export class DashboardDocumentTreeItem extends vscode.TreeItem {
  constructor(readonly document: DashboardDocument, language: string) {
    super(document.name, vscode.TreeItemCollapsibleState.None);
    this.tooltip = document.path;
    this.contextValue = "f4datadashb.dashboardDocument";
    this.command = {
      command: "vscode.open",
      title: translate(language, "openDocumentAction"),
      arguments: [vscode.Uri.file(document.path)]
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
    selected = false
  ) {
    super(dashboard.displayName, vscode.TreeItemCollapsibleState.None);
    this.description = dashboard.description;
    this.tooltip = dashboard.description
      ? `${dashboard.displayName}\n${dashboard.description}\n${dashboard.path}`
      : `${dashboard.displayName}\n${dashboard.path}`;
    this.contextValue = fromFavorites
      ? "f4datadashb.favoriteDashboardItem"
      : favorite
        ? "f4datadashb.dashboardFavoriteItem"
        : "f4datadashb.dashboardItem";
    this.command = {
      command: "f4datadashb.openDashboard",
      title: translate(language, "openDashboardAction"),
      arguments: [dashboard.path]
    };
    this.iconPath = new vscode.ThemeIcon(
      selected ? "screen-normal" : "screen-full"
    );
  }
}

export class DashboardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private dashboards: DashboardInfo[] = [];
  private readonly itemsByPath = new Map<string, DashboardTreeItem>();
  private favoritePaths = new Set<string>();
  private selectedDashboardPath: string | undefined;

  constructor(private readonly state: vscode.Memento, private readonly language: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    this.itemsByPath.clear();
    return this.dashboards.map((dashboard) => {
      const item = new DashboardTreeItem(
        dashboard,
        this.language,
        this.favoritePaths.has(dashboard.path),
        false,
        dashboard.path === this.selectedDashboardPath
      );
      this.itemsByPath.set(dashboard.path, item);
      return item;
    });
  }

  setSelectedDashboard(dashboardPath: string | undefined): void {
    if (this.selectedDashboardPath === dashboardPath) {
      return;
    }
    const previousPath = this.selectedDashboardPath;
    this.selectedDashboardPath = dashboardPath;
    for (const pathToUpdate of [previousPath, dashboardPath]) {
      if (!pathToUpdate) {
        continue;
      }
      const item = this.itemsByPath.get(pathToUpdate);
      if (item) {
        item.iconPath = new vscode.ThemeIcon(
          pathToUpdate === dashboardPath ? "screen-normal" : "screen-full"
        );
        this.changeEmitter.fire(item);
      }
    }
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

  async refresh(): Promise<number> {
    const storedPaths = this.state.get<string[]>("dashboards", []);
    const next: DashboardInfo[] = [];
    const seen = new Set<string>();
    let invalidCount = 0;
    for (const storedPath of storedPaths) {
      try {
        const dashboard = readDashboard(storedPath);
        if (!seen.has(dashboard.path)) {
          seen.add(dashboard.path);
          next.push(dashboard);
        }
      } catch {
        invalidCount++;
      }
    }
    this.dashboards = next;
    await this.state.update("dashboards", next.map((dashboard) => dashboard.path));
    const storedFavorites = this.state.get<string[]>("favoriteDashboards", []);
    const dashboardPaths = new Set(next.map((dashboard) => dashboard.path));
    this.favoritePaths = new Set(storedFavorites.filter((dashboardPath) => dashboardPaths.has(dashboardPath)));
    if (this.favoritePaths.size !== storedFavorites.length) {
      await this.state.update("favoriteDashboards", [...this.favoritePaths]);
    }
    this.changeEmitter.fire(undefined);
    return invalidCount;
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
    this.changeEmitter.dispose();
  }
}

export class DashboardFavoritesTreeProvider implements vscode.TreeDataProvider<DashboardTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<DashboardTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly itemsByPath = new Map<string, DashboardTreeItem>();
  private selectedDashboardPath: string | undefined;
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
        dashboard.path === this.selectedDashboardPath
      );
      this.itemsByPath.set(dashboard.path, item);
      return item;
    });
  }

  setSelectedDashboard(dashboardPath: string | undefined): void {
    if (this.selectedDashboardPath === dashboardPath) {
      return;
    }
    const previousPath = this.selectedDashboardPath;
    this.selectedDashboardPath = dashboardPath;
    for (const dashboardPathToUpdate of [previousPath, dashboardPath]) {
      if (!dashboardPathToUpdate) {
        continue;
      }
      const item = this.itemsByPath.get(dashboardPathToUpdate);
      if (item) {
        item.iconPath = new vscode.ThemeIcon(
          dashboardPathToUpdate === dashboardPath ? "screen-normal" : "screen-full"
        );
        this.changeEmitter.fire(item);
      }
    }
  }

  dispose(): void {
    this.favoritesChanged.dispose();
    this.changeEmitter.dispose();
  }
}

export class DashboardDocumentsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private dashboards: DashboardInfo[] = [];
  private readonly documentWatchers: vscode.Disposable[] = [];
  private documentRefreshTimer: NodeJS.Timeout | undefined;
  private readonly dashboardChanges: vscode.Disposable;

  constructor(
    private readonly state: vscode.Memento,
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
    if (element instanceof DashboardDocumentsTreeItem) {
      return element.documents.map((document) => new DashboardDocumentTreeItem(document, this.language));
    }
    if (element) {
      return [];
    }
    return this.dashboards.flatMap((dashboard) => {
      const documents = listDashboardDocuments(dashboard.path);
      return documents.length > 0
        ? [new DashboardDocumentsTreeItem(dashboard, documents)]
        : [];
    });
  }

  async refresh(): Promise<void> {
    const storedPaths = this.state.get<string[]>("dashboards", []);
    const dashboards: DashboardInfo[] = [];
    for (const storedPath of storedPaths) {
      try {
        dashboards.push(readDashboard(storedPath));
      } catch {
        continue;
      }
    }
    this.dashboards = dashboards;
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
    for (const dashboard of this.dashboards) {
      const dashboardUri = vscode.Uri.file(dashboard.path);
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
