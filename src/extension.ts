import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { DashboardInfo, findDashboards, normalizePath, readDashboard } from "./dashboardService";
import { DashboardTreeItem, DashboardTreeProvider } from "./dashboardTree";
import { DashboardWebviewManager } from "./dashboardWebview";
import { DuckDbService } from "./duckdbService";
import { translate } from "./i18n";

export function activate(context: vscode.ExtensionContext): void {
  const language = vscode.env.language;
  const t = (key: Parameters<typeof translate>[1], ...values: string[]) => translate(language, key, ...values);
  const tree = new DashboardTreeProvider(context.globalState, language);
  const duckDb = new DuckDbService();
  const webviews = new DashboardWebviewManager(context, duckDb, language);
  const treeView = vscode.window.createTreeView("f4datadashb.dashboards", { treeDataProvider: tree });
  context.subscriptions.push(treeView, tree);

  void tree.refresh().then((invalidCount) => {
    if (invalidCount > 0) {
      void vscode.window.showWarningMessage(t("invalidStoredDashboards", String(invalidCount)));
    }
  }).catch((error: unknown) => {
    void vscode.window.showErrorMessage(t("importFailed", errorMessage(error)));
  });

  context.subscriptions.push(
    vscode.commands.registerCommand("f4datadashb.importDashboard", async () => {
      try {
        const selections = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: t("chooseDashboardFolders"),
          title: t("chooseDashboardFolders")
        });
        if (!selections?.length) {
          return;
        }
        const candidates = findDashboards(selections.map((selection) => selection.fsPath));
        if (!candidates.length) {
          void vscode.window.showInformationMessage(t("noDashboardsFound"));
          return;
        }
        const added = await tree.add(candidates);
        void vscode.window.showInformationMessage(t("dashboardImported", String(added)));
      } catch (error) {
        void vscode.window.showErrorMessage(t("importFailed", errorMessage(error)));
      }
    }),
    vscode.commands.registerCommand("f4datadashb.createDashboard", async () => {
      try {
        const displayName = await promptDashboardTitle(t);
        if (!displayName) {
          return;
        }
        const locations = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: t("chooseCreateLocation"),
          title: t("folderPickerTitle")
        });
        if (!locations?.length) {
          return;
        }
        await initializeDashboard(locations[0].fsPath, displayName, language, tree, t);
      } catch (error) {
        void vscode.window.showErrorMessage(t("createFailed", errorMessage(error)));
      }
    }),
    vscode.commands.registerCommand("f4datadashb.generateDashboardInFolder", async (resource?: vscode.Uri) => {
      try {
        if (!resource || resource.scheme !== "file" || !fs.statSync(resource.fsPath).isDirectory()) {
          void vscode.window.showErrorMessage(t("selectFolderError"));
          return;
        }
        const displayName = await promptDashboardTitle(t);
        if (!displayName) {
          return;
        }
        await initializeDashboard(resource.fsPath, displayName, language, tree, t);
      } catch (error) {
        void vscode.window.showErrorMessage(t("createFailed", errorMessage(error)));
      }
    }),
    vscode.commands.registerCommand("f4datadashb.removeDashboard", async (item?: DashboardTreeItem) => {
      const dashboard = item?.dashboard;
      if (!dashboard) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        t("removeConfirmation", dashboard.displayName),
        { modal: true },
        t("removeAction"),
        t("cancel")
      );
      if (answer !== t("removeAction")) {
        return;
      }
      try {
        await tree.remove(dashboard.path);
        void vscode.window.showInformationMessage(t("dashboardRemoved", dashboard.displayName));
      } catch (error) {
        void vscode.window.showErrorMessage(t("removeFailed", errorMessage(error)));
      }
    }),
    vscode.commands.registerCommand("f4datadashb.openDashboard", async (item?: DashboardTreeItem) => {
      const dashboard = item?.dashboard;
      if (!dashboard) {
        return;
      }
      try {
        const current = readDashboard(dashboard.path);
        webviews.open(current.path, current.displayName);
      } catch (error) {
        const reason = error instanceof Error && error.message.startsWith("invalid-package:")
          ? t("invalidPackage", error.message.slice("invalid-package:".length))
          : error instanceof Error && error.message === "invalid-dashboard"
            ? t("invalidDashboard")
            : errorMessage(error);
        void vscode.window.showErrorMessage(t("openFailed", dashboard.displayName, reason));
      }
    })
  );
}

export function deactivate(): void {}

type Translator = (key: Parameters<typeof translate>[1], ...values: string[]) => string;

async function promptDashboardTitle(t: Translator): Promise<string | undefined> {
  const title = await vscode.window.showInputBox({
    prompt: t("dashboardTitle"),
    validateInput: (value) => toTechnicalName(value)
      ? undefined
      : t("invalidName")
  });
  return title?.trim() || undefined;
}

async function initializeDashboard(
  selectedPath: string,
  displayName: string,
  language: string,
  tree: DashboardTreeProvider,
  t: Translator
): Promise<void> {
  const dashboardPath = normalizePath(selectedPath);
  const technicalName = toTechnicalName(displayName);
  const manifestPath = path.join(dashboardPath, "package.json");
  const manifest = mergeDashboardManifest(
    fs.existsSync(manifestPath) ? readPackageManifest(manifestPath) : {},
    technicalName,
    displayName
  );
  const generatedFiles = getDashboardFiles(displayName, language);
  const filesToWrite = new Map(generatedFiles);
  for (const relativePath of generatedFiles.keys()) {
    const existingPath = path.join(dashboardPath, relativePath);
    if (!fs.existsSync(existingPath)) {
      continue;
    }
    if (!fs.statSync(existingPath).isFile()) {
      throw new Error(`${relativePath} exists and is not a file`);
    }
    const answer = await vscode.window.showWarningMessage(
      t("generatedFileExists", relativePath),
      { modal: true },
      t("replaceFile"),
      t("keepFile"),
      t("cancel")
    );
    if (answer === t("cancel") || answer === undefined) {
      return;
    }
    if (answer === t("keepFile")) {
      filesToWrite.delete(relativePath);
    }
  }

  for (const directory of ["data", "vue", "src"]) {
    fs.mkdirSync(path.join(dashboardPath, directory), { recursive: true });
  }
  for (const [relativePath, contents] of filesToWrite) {
    const filePath = path.join(dashboardPath, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${contents.trim()}\n`, "utf8");
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const dashboard = readDashboard(dashboardPath);
  await tree.add([dashboard]);
  void vscode.window.showInformationMessage(t("dashboardCreated", displayName));
}

function toTechnicalName(title: string): string {
  return title.trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getDashboardFiles(title: string, language: string): Map<string, string> {
  return new Map([
    ["vite.config.js", viteConfig],
    [path.join("vue", "index.html"), dashboardPlaceholder(title, language)],
    [path.join("src", "index.html"), htmlTemplate(title)],
    [path.join("src", "App.jsx"), appTemplate(title)],
    [path.join("src", "style.css"), appStyles],
    ["SKILL_GUIDE.md", skillGuide(title)]
  ]);
}

function readPackageManifest(manifestPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("package.json must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function mergeDashboardManifest(
  existing: Record<string, unknown>,
  technicalName: string,
  title: string
): Record<string, unknown> {
  const defaultScripts = {
    dev: "vite --host 127.0.0.1",
    build: "vite build",
    watch: "vite build --watch"
  };
  const defaultDependencies = {
    react: "^18.3.1",
    "react-dom": "^18.3.1"
  };
  const defaultDevDependencies = {
    "@vitejs/plugin-react": "^4.3.1",
    vite: "^5.4.0"
  };
  const existingScripts = asStringRecord(existing.scripts);
  const existingDependencies = asStringRecord(existing.dependencies);
  const existingDevDependencies = asStringRecord(existing.devDependencies);

  return {
    ...existing,
    name: technicalName,
    displayName: title,
    title,
    version: typeof existing.version === "string" ? existing.version : "1.0.0",
    private: typeof existing.private === "boolean" ? existing.private : true,
    description: typeof existing.description === "string" ? existing.description : `${title} data dashboard`,
    scripts: { ...defaultScripts, ...existingScripts },
    dependencies: { ...defaultDependencies, ...existingDependencies },
    devDependencies: { ...defaultDevDependencies, ...existingDevDependencies }
  };
}

function asStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function dashboardPlaceholder(title: string, language: string): string {
  const instruction = translate(language, "buildRequired");
  const lang = language.toLowerCase().startsWith("fr") ? "fr" : "en";
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(instruction)}</p>
    </main>
  </body>
</html>`;
}

const viteConfig = `
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const projectDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(projectDirectory, "src"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(projectDirectory, "vue"),
    emptyOutDir: true
  }
});
`;

const appStyles = `
:root {
  color-scheme: light dark;
  font-family: var(--vscode-font-family, sans-serif);
  color: var(--vscode-foreground, #222);
  background: var(--vscode-editor-background, #fff);
}
body { margin: 0; padding: 1.25rem; }
main { max-width: 1100px; margin: 0 auto; }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
button {
  padding: 0.4rem 0.8rem;
  color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, #1769aa);
  border: 0;
  border-radius: 3px;
  cursor: pointer;
}
textarea {
  display: block;
  width: 100%;
  min-height: 6rem;
  margin: 0.5rem 0;
  color: inherit;
  background: var(--vscode-input-background, transparent);
  border: 1px solid var(--vscode-input-border, #888);
}
section { overflow: auto; margin-top: 1.5rem; }
pre { padding: 1rem; overflow: auto; background: var(--vscode-textCodeBlock-background, #8882); }
`;

function htmlTemplate(title: string): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./App.jsx"></script>
  </body>
</html>`;
}

function appTemplate(title: string): string {
  const titleValue = JSON.stringify(title);
  return `import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
const dashboardTitle = ${titleValue};
const browserData = {
  files: ["Browser preview"],
  datasets: [{
    name: "Sample data",
    columns: ["category", "value"],
    rows: [{ category: "Example", value: 42 }]
  }]
};

function App() {
  const [state, setState] = useState({ status: "loading", data: null, error: "" });
  const [sql, setSql] = useState("SHOW TABLES");
  const [result, setResult] = useState(null);
  const french = navigator.language.toLowerCase().startsWith("fr");

  useEffect(() => {
    const onMessage = (event) => {
      const message = event.data;
      if (message.command === "initData") {
        const datasets = message.data?.datasets ?? [];
        setState({
          status: datasets.length > 0 ? "ready" : "empty",
          data: message.data,
          error: ""
        });
      } else if (message.command === "dashboardError") {
        setState({ status: "error", data: null, error: message.error });
      } else if (message.command === "queryResult") {
        setResult(message);
      } else if (message.command === "queryError") {
        setState((current) => ({ ...current, error: message.error }));
      }
    };
    window.addEventListener("message", onMessage);
    if (vscode) {
      vscode.postMessage({ command: "ready" });
    } else {
      setState({ status: "ready", data: browserData, error: "" });
    }
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const refresh = () => {
    if (vscode) {
      vscode.postMessage({ command: "refresh" });
    } else {
      setResult(null);
      setState({ status: "ready", data: browserData, error: "" });
    }
  };

  const query = () => {
    if (vscode) {
      vscode.postMessage({
        command: "runQuery",
        requestId: String(Date.now()),
        sql,
        force: true
      });
    } else {
      setResult({
        name: "Browser preview (sample data)",
        columns: browserData.datasets[0].columns,
        rows: browserData.datasets[0].rows
      });
    }
  };

  if (state.status === "loading") return <main><p role="status">{french ? "Chargement des données…" : "Loading data…"}</p></main>;
  if (state.status === "error") return <main><h1>{dashboardTitle}</h1><p role="alert">{state.error}</p><button onClick={refresh}>{french ? "Réessayer" : "Retry"}</button></main>;
  if (state.status === "empty") return <main><h1>{dashboardTitle}</h1><p>{french ? "Aucun fichier CSV, TSV, Parquet ou DuckDB dans data/." : "No CSV, TSV, Parquet, or DuckDB file in data/."}</p></main>;

  return <main>
    <header><h1>{dashboardTitle}</h1><button onClick={refresh}>{french ? "Actualiser" : "Refresh"}</button></header>
    <p>{state.data.files.join(", ")}</p>
    <label htmlFor="sql">{french ? "Requête DuckDB" : "DuckDB query"}</label>
    <textarea id="sql" value={sql} onChange={(event) => setSql(event.target.value)} />
    <button onClick={query}>{french ? "Exécuter" : "Run"}</button>
    {state.error && <p role="alert">{state.error}</p>}
    {(result ? [result] : state.data.datasets).map((dataset, index) => <section key={dataset.name ?? index}>
      <h2>{dataset.name ?? (french ? "Résultat de la requête" : "Query result")}</h2>
      {dataset.error ? <p role="alert">{dataset.error}</p> : <pre>{JSON.stringify(dataset.rows, null, 2)}</pre>}
    </section>)}
  </main>;
}

createRoot(document.getElementById("root")).render(<App />);
`;
}

function skillGuide(title: string): string {
  return `# ${title} — guide de développement

Ce dashboard est une application React construite avec Vite. Les sources sont dans \`src/\` et le build est écrit dans \`vue/\`, que l’extension VS Code charge dans une Webview.

## Démarrage

- \`npm install\` installe React, Vite et le plugin React.
- \`npm run dev\` démarre le dashboard dans un navigateur pour le développement.
- \`npm run build\` produit \`vue/index.html\`, utilisé par l’extension.
- \`npm run watch\` reconstruit le dashboard à chaque changement ; la Webview active se recharge automatiquement.

## Communication navigateur / VS Code

La présence de \`acquireVsCodeApi()\` indique l’exécution dans une Webview VS Code. Appelez cette fonction une seule fois et conservez son résultat. Dans le navigateur, utilisez un pont facultatif ou des données de démonstration : ne supposez pas que l’API VS Code existe.

Dans la Webview, écoutez les messages \`window.addEventListener("message", ...)\` et envoyez les commandes avec \`vscode.postMessage(...)\`. Envoyez \`{ command: "ready" }\` après l’installation du gestionnaire d’événements. L’extension répond avec \`{ command: "initData", data }\`. La commande \`refresh\` recharge les données et \`runQuery\` exécute une requête DuckDB ; les réponses sont \`queryResult\` ou \`queryError\`.

La communication est bidirectionnelle : l’extension envoie les données et résultats à la Webview, et l’interface demande des actualisations ou des requêtes à l’extension. Vérifiez les messages reçus et n’envoyez pas de données non sérialisables.

## États d’interface obligatoires

Toute vue de données doit présenter clairement ces quatre états :

1. **Chargement** : requête ou initialisation en cours.
2. **Erreur** : erreur de lecture ou de requête affichée avec une action de récupération.
3. **Vide** : aucune donnée disponible, avec une indication sur la manière d’en ajouter.
4. **Nominal** : visualisation des données et accès aux actions utiles.

Conservez ces états lors de toute évolution du dashboard, y compris pour les vues alimentées par une requête utilisateur.
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character] ?? character);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
