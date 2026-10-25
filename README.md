# F4Data Dashboards for VS Code

This extension imports, creates, and opens local data dashboards in VS Code Webviews. Imported dashboard folders are stored in `globalState` and are not required to be inside the current workspace.

## Requirements

A dashboard folder must contain:

```text
dashboard/
├── package.json
├── data/
└── vue/
    └── index.html
```

The importer accepts a dashboard folder directly or scans only its immediate child folders. It does not perform a recursive search.

## Extension development

1. Open this extension project folder itself in VS Code (not only its parent folder).
2. Run `npm install`.
3. Open **Run and Debug** and select **Run F4Data Dashboards**, then press **F5**. The launch configuration compiles the extension before starting the Extension Development Host.
4. If prompted to select a debugger, choose **VS Code Extension Development**.

The **F4Data Dashboards** view is available from its Activity Bar icon. When no dashboards are registered, its welcome links let you create a dashboard or add an existing one. The view title actions also import or create dashboards; right-click a dashboard to remove it from the list without deleting its files.

If the host window opens but the view is missing, run **Developer: Reload Window** in that window and check the **Log (Extension Host)** output for activation errors.

## Build a local VSIX

Run `npm install`, then `npm run package:extension`. The installable extension package is generated at `package/f4datadashb-0.0.11.vsix`. The `package/` output folder is ignored by Git. Install it in VS Code with **Extensions: Install from VSIX...**.

Pushing a version tag such as `v0.0.11` publishes the platform-specific VSIX packages to the Visual Studio Marketplace after CI succeeds. Set `publisher` in `package.json` to your Marketplace publisher ID and add a `VSCE_PAT` repository Actions secret with Marketplace publish permission.

## Generated dashboard projects

The create command initializes the folder you select directly (it does not create a child folder). You can also right-click a folder in the VS Code Explorer and choose **Initialize F4Data Dashboard in This Folder**. It creates the dashboard directories and Vite/React files there, merges the dashboard metadata, scripts, and dependencies into an existing `package.json`, and preserves unrelated manifest fields. Existing generated files prompt before replacement. Run `npm install` in the selected folder, then:

- `npm run dev` for browser development.
- `npm run build` to produce the Webview files in `vue/`.
- `npm run watch` to rebuild as source files change; an open Webview reloads automatically.

`SKILL_GUIDE.md` is generated with the Webview messaging contract and required loading, error, empty, and nominal UI states.

## Data and queries

CSV, TSV, Parquet, and DuckDB files directly inside `data/` are discovered. Initial data is sampled into the Webview, and dashboard requests can execute DuckDB SQL against the data views. Query results are cached by SQL and data-file fingerprint; changing a file invalidates the cache. Each operation closes its DuckDB connection and instance.
