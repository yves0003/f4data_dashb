import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DuckDbRuntimeOptions, DuckDbService } from "./duckdbService";
import { MessageKey, translate } from "./i18n";
import {
  InsufficientCopySpaceError,
  LocalCopyLease,
  LocalCopyService,
  readLocalCopyOptions
} from "./localCopyService";

export class DashboardWebviewManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly duckDb: DuckDbService,
    private readonly language: string,
    private readonly localCopies: LocalCopyService
  ) {}

  async open(dashboardPath: string, title: string): Promise<void> {
    const resolvedPath = path.resolve(dashboardPath);
    const vuePath = path.join(resolvedPath, "vue");
    const dataPath = path.join(resolvedPath, "data");
    if (!fs.existsSync(path.join(vuePath, "index.html"))) {
      throw new Error(translate(this.language, "dashboardNotReady"));
    }
    const databaseOptions = readDuckDbRuntimeOptions();
    let activeCopy = await this.prepareLocalCopy(resolvedPath);
    let activeDataPath = activeCopy?.dataPath;
    let databaseLease = databaseOptions.reuseInstance
      ? this.duckDb.retainDashboard(resolvedPath, activeDataPath)
      : undefined;
    const dataWatchPatterns = this.duckDb.getDataWatchPatterns(resolvedPath, activeDataPath);
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel(
        "f4datadashb.dashboard",
        title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(vuePath), vscode.Uri.file(dataPath)]
        }
      );
    } catch (error) {
      await databaseLease?.dispose();
      await activeCopy?.dispose();
      throw error;
    }
    let ready = false;
    let disposed = false;

    const vueWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(vuePath), "**/*")
    );
    const dataWatchers = dataWatchPatterns.map(({ basePath, pattern }) =>
      vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(basePath), pattern)
      )
    );

    const updateHtml = (): void => {
      try {
        try {
          panel.webview.html = this.renderHtml(panel.webview, vuePath);
        } catch (error) {
          panel.dispose();
          throw error;
        }
      } catch (error) {
        void this.sendError(panel.webview, error);
      }
    };

    const sendInitialData = async (force: boolean): Promise<void> => {
      try {
        const data = await this.duckDb.loadInitialData(
          resolvedPath,
          force,
          activeDataPath,
          databaseOptions
        );
        await panel.webview.postMessage({ command: "initData", data });
      } catch (error) {
        await this.sendError(panel.webview, error);
      }
    };

    const invalidateData = async (): Promise<void> => {
      try {
        await this.duckDb.invalidate(resolvedPath, activeDataPath);
        if (ready) {
          await sendInitialData(true);
        }
      } catch (error) {
        await this.sendError(panel.webview, error);
      }
    };

    const refreshLocalCopy = async (): Promise<void> => {
      const nextCopy = await this.prepareLocalCopy(resolvedPath, true);
      if (!nextCopy || disposed) {
        await nextCopy?.dispose();
        return;
      }
      await this.duckDb.invalidate(resolvedPath);
      await databaseLease?.dispose();
      const previousCopy = activeCopy;
      activeCopy = nextCopy;
      activeDataPath = nextCopy.dataPath;
      databaseLease = databaseOptions.reuseInstance
        ? this.duckDb.retainDashboard(resolvedPath, activeDataPath)
        : undefined;
      await previousCopy?.dispose();
      if (ready) {
        await sendInitialData(true);
      }
    };

    let sourceChangeTimer: NodeJS.Timeout | undefined;
    let updatePromptOpen = false;
    const sourceWatcher = activeCopy
      ? vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dataPath), "**/*")
      )
      : undefined;
    const promptForCopyUpdate = async (): Promise<void> => {
      if (!activeCopy || updatePromptOpen || disposed) {
        return;
      }
      updatePromptOpen = true;
      try {
        const action = await vscode.window.showInformationMessage(
          translate(this.language, "localCopySourceChanged"),
          translate(this.language, "updateLocalCopy")
        );
        if (action === translate(this.language, "updateLocalCopy")) {
          await refreshLocalCopy();
        }
      } finally {
        updatePromptOpen = false;
      }
    };
    const scheduleCopyUpdatePrompt = (): void => {
      if (sourceChangeTimer) {
        clearTimeout(sourceChangeTimer);
      }
      sourceChangeTimer = setTimeout(() => {
        void promptForCopyUpdate().catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            translate(this.language, "localCopyFailed", errorMessage(error))
          );
        });
      }, 1000);
    };

    const subscriptions: vscode.Disposable[] = [
      vueWatcher,
      ...dataWatchers,
      ...(sourceWatcher ? [sourceWatcher] : []),
      vueWatcher.onDidChange(updateHtml),
      vueWatcher.onDidCreate(updateHtml),
      vueWatcher.onDidDelete(updateHtml),
      ...(sourceWatcher ? [
        sourceWatcher.onDidChange(scheduleCopyUpdatePrompt),
        sourceWatcher.onDidCreate(scheduleCopyUpdatePrompt),
        sourceWatcher.onDidDelete(scheduleCopyUpdatePrompt)
      ] : []),
      ...dataWatchers.flatMap((watcher) => [
        watcher.onDidChange(() => { void invalidateData(); }),
        watcher.onDidCreate(() => { void invalidateData(); }),
        watcher.onDidDelete(() => { void invalidateData(); })
      ]),
      panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isWebviewMessage(message)) {
          return;
        }
        if (message.command === "ready") {
          ready = true;
          await sendInitialData(false);
          return;
        }
        if (message.command === "refresh") {
          await this.duckDb.invalidate(resolvedPath, activeDataPath);
          await sendInitialData(true);
          return;
        }
        if (message.command === "runQuery" && typeof message.sql === "string") {
          try {
            const result = await this.duckDb.query(
              resolvedPath,
              message.sql,
              message.force === true,
              activeDataPath,
              databaseOptions
            );
            await panel.webview.postMessage({
              command: "queryResult",
              requestId: message.requestId,
              columns: result.columns,
              rows: result.rows
            });
          } catch (error) {
            await panel.webview.postMessage({
              command: "queryError",
              requestId: message.requestId,
              error: translate(this.language, "queryFailed", errorMessage(error))
            });
          }
        }
      }),
      panel.onDidDispose(() => {
        disposed = true;
        if (sourceChangeTimer) {
          clearTimeout(sourceChangeTimer);
        }
        void (async () => {
          await databaseLease?.dispose();
          await activeCopy?.dispose();
        })().catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            translate(this.language, "localCopyFailed", errorMessage(error))
          );
        });
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
      })
    ];

    panel.webview.html = this.renderHtml(panel.webview, vuePath);
    this.context.subscriptions.push({
      dispose: () => {
        if (!disposed) {
          panel.dispose();
        }
      }
    });
  }

  private async prepareLocalCopy(
    dashboardPath: string,
    retry = false
  ): Promise<LocalCopyLease | undefined> {
    const options = readLocalCopyOptions(vscode.workspace.getConfiguration("f4datadashb"));
    if (options.mode === "off") {
      return undefined;
    }
    while (true) {
      try {
        return await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: translate(this.language, "preparingLocalCopy"),
          cancellable: true
        }, (progress, token) => this.localCopies.prepare(
          dashboardPath,
          options,
          {
            report: (message, increment) => progress.report({ message, increment })
          },
          token
        ));
      } catch (error) {
        if (error instanceof InsufficientCopySpaceError) {
          void vscode.window.showErrorMessage(translate(
            this.language,
            "localCopyInsufficientSpace",
            formatBytes(error.requiredBytes),
            formatBytes(error.availableBytes)
          ));
          return undefined;
        }
        const retryAction = translate(this.language, "retryLocalCopy");
        const fallbackAction = translate(this.language, "useNetworkSource");
        const action = await vscode.window.showErrorMessage(
          translate(this.language, "localCopyFailed", errorMessage(error)),
          retryAction,
          fallbackAction
        );
        if (action !== retryAction || retry) {
          return undefined;
        }
        retry = true;
      }
    }
  }

  private renderHtml(webview: vscode.Webview, vuePath: string): string {
    const indexPath = path.join(vuePath, "index.html");
    if (!fs.existsSync(indexPath)) {
      throw new Error(translate(this.language, "dashboardNotReady"));
    }
    const vueUri = vscode.Uri.file(vuePath);
    const nonce = getNonce();
    let html = fs.readFileSync(indexPath, "utf8");
    html = html.replace(/(src|href)=["']([^"']+)["']/gi, (match, attribute: string, resource: string) => {
      if (/^(?:[a-z]+:|#|\/\/)/i.test(resource)) {
        return match;
      }
      const relativePath = decodeURIComponent(resource).replace(/^\.?\//, "").replace(/^\/+/, "");
      const resourceUri = webview.asWebviewUri(vscode.Uri.joinPath(vueUri, relativePath));
      return `${attribute}="${resourceUri.toString()}"`;
    });
    html = html.replace(/<script(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);

    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: https:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} https:`
    ].join("; ");
    const cspElement = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    return /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (head) => `${head}\n${cspElement}`)
      : `${cspElement}${html}`;
  }

  private async sendError(webview: vscode.Webview, error: unknown): Promise<void> {
    await webview.postMessage({
      command: "dashboardError",
      error: translate(this.language, "dashboardOperationFailed", errorMessage(error))
    });
  }
}

function isWebviewMessage(value: unknown): value is {
  command: string;
  sql?: string;
  requestId?: string;
  force?: boolean;
} {
  return typeof value === "object" && value !== null && "command" in value
    && typeof value.command === "string";
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readDuckDbRuntimeOptions(): DuckDbRuntimeOptions {
  const configuration = vscode.workspace.getConfiguration("f4datadashb");
  const reuseInstance = configuration.get<unknown>("reuseDuckDbInstance", false);
  const idleReleaseSeconds = configuration.get<unknown>("duckdbIdleReleaseSeconds", 120);
  const maxConcurrency = configuration.get<unknown>("duckdbMaxConcurrency", 4);
  if (typeof reuseInstance !== "boolean") {
    throw new Error("f4datadashb.reuseDuckDbInstance must be a boolean");
  }
  if (typeof idleReleaseSeconds !== "number" || !Number.isInteger(idleReleaseSeconds) || idleReleaseSeconds < 0) {
    throw new Error("f4datadashb.duckdbIdleReleaseSeconds must be a non-negative integer");
  }
  if (typeof maxConcurrency !== "number" || !Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("f4datadashb.duckdbMaxConcurrency must be a positive integer");
  }
  return { reuseInstance, idleReleaseSeconds, maxConcurrency };
}
