import * as vscode from "vscode";
import { DashboardInfo, readDashboard } from "./dashboardService";
import { translate } from "./i18n";

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(readonly dashboard: DashboardInfo, language: string) {
    super(dashboard.displayName, vscode.TreeItemCollapsibleState.None);
    this.description = dashboard.description;
    this.tooltip = dashboard.description
      ? `${dashboard.displayName}\n${dashboard.description}\n${dashboard.path}`
      : `${dashboard.displayName}\n${dashboard.path}`;
    this.contextValue = "f4datadashb.dashboardItem";
    this.command = {
      command: "f4datadashb.openDashboard",
      title: translate(language, "openDashboardAction"),
      arguments: [this]
    };
    this.iconPath = new vscode.ThemeIcon("dashboard");
  }
}

export class DashboardTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private dashboards: DashboardInfo[] = [];

  constructor(private readonly state: vscode.Memento, private readonly language: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.dashboards.length === 0) {
      return [];
    }
    return this.dashboards.map((dashboard) => new DashboardTreeItem(dashboard, this.language));
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
