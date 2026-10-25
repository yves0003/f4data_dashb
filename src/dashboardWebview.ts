import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DuckDbService } from "./duckdbService";
import { MessageKey, translate } from "./i18n";

export class DashboardWebviewManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly duckDb: DuckDbService,
    private readonly language: string
  ) {}

  open(dashboardPath: string, title: string): void {
    const resolvedPath = path.resolve(dashboardPath);
    const vuePath = path.join(resolvedPath, "vue");
    const dataPath = path.join(resolvedPath, "data");
    if (!fs.existsSync(path.join(vuePath, "index.html"))) {
      throw new Error(translate(this.language, "dashboardNotReady"));
    }
    const panel = vscode.window.createWebviewPanel(
      "f4datadashb.dashboard",
      title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(vuePath), vscode.Uri.file(dataPath)]
      }
    );
    let ready = false;
    let disposed = false;

    const vueWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(vuePath), "**/*")
    );
    const dataWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dataPath), "**/*")
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
        const data = await this.duckDb.loadInitialData(resolvedPath, force);
        await panel.webview.postMessage({ command: "initData", data });
      } catch (error) {
        await this.sendError(panel.webview, error);
      }
    };

    const subscriptions: vscode.Disposable[] = [
      vueWatcher,
      dataWatcher,
      vueWatcher.onDidChange(updateHtml),
      vueWatcher.onDidCreate(updateHtml),
      vueWatcher.onDidDelete(updateHtml),
      dataWatcher.onDidChange(() => {
        this.duckDb.invalidate(resolvedPath);
        if (ready) {
          void sendInitialData(true);
        }
      }),
      dataWatcher.onDidCreate(() => {
        this.duckDb.invalidate(resolvedPath);
        if (ready) {
          void sendInitialData(true);
        }
      }),
      dataWatcher.onDidDelete(() => {
        this.duckDb.invalidate(resolvedPath);
        if (ready) {
          void sendInitialData(true);
        }
      }),
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
          this.duckDb.invalidate(resolvedPath);
          await sendInitialData(true);
          return;
        }
        if (message.command === "runQuery" && typeof message.sql === "string") {
          try {
            const result = await this.duckDb.query(resolvedPath, message.sql, message.force === true);
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
