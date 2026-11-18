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

Keep the `data/` directory even when using `dataSources`; it is part of the dashboard folder structure expected by the extension. When `dataSources` is configured, its contents are used instead of scanning `data/`.

The importer accepts a dashboard folder directly or scans only its immediate child folders. It does not perform a recursive search.

## Use the extension

Open the **F4Data Dashboards** view from the Activity Bar. Use its **+** action to create a dashboard, or its import action to add an existing dashboard. You can also right-click a folder in the VS Code Explorer and choose **Initialize F4Data Dashboard in This Folder**. Select a dashboard in the view to open it; removing it from the view does not delete its files.

## Generated dashboard projects

The create command first lets you choose a React or native HTML/CSS/JavaScript template, then initializes the folder you select directly (it does not create a child folder). You can also right-click a folder in the VS Code Explorer and choose **Initialize F4Data Dashboard in This Folder**; that command offers the same template choices. It merges the selected framework's scripts and dependencies into an existing `package.json` and preserves unrelated manifest fields. Existing generated files prompt before replacement.

For the **React** template, run `npm install`, then use `npm run dev` for browser development, `npm run build` to produce Webview files in `vue/`, and `npm run watch` for rebuilds while editing.

The **HTML/CSS/JavaScript** template writes ready-to-run static files directly into `vue/`. It does not use Vite, require an install, or need a build step; open `vue/index.html` in a browser to preview it. The extension's Webview watcher reloads the dashboard when these files change.

`SKILL_GUIDE.md` is generated with the Webview messaging contract and required loading, error, empty, and nominal UI states.

## Data and queries

By default, CSV, TSV, Parquet, and DuckDB files directly inside `data/` are discovered. Alternatively, add a `dataSources` array to the dashboard's `package.json` to select external sources:

```json
{
  "dataSources": [
    {
      "name": "warehouse",
      "type": "duckdb",
      "path": "../shared/warehouse.duckdb"
    },
    {
      "name": "sales",
      "type": "csv",
      "path": "../exports/sales"
    }
  ]
}
```

Each source needs a unique `name`, a `type` (`duckdb`, `csv`, `tsv`, or `parquet`), and a `path`. Paths may be absolute or relative to the dashboard root. A file path selects that file; a directory path selects matching files directly inside that directory (not recursively). Each configured source must resolve to at least one file of its declared type.

A configured `dataSources` property is authoritative: the extension uses only those sources and does not scan `data/`, even if the array is empty. Remove the property to use the default `data/` folder again.

CSV/TSV/Parquet files are exposed to DuckDB as views named after the source (`"sales"` above). For a source pointing to a directory, each file gets a view named `<source-name>_<file-name-without-extension>`. DuckDB databases are attached read-only. For a single-file source, its database alias is the source name, so a table can be queried as `"warehouse".main.my_table`; for a directory source, each database alias is `<source-name>_<file-name-without-extension>`.

For example, query a configured CSV view with `SELECT * FROM "sales"` or a table in the configured DuckDB file with `SELECT * FROM "warehouse".main.my_table`. Changing files in configured source directories invalidates the cache and refreshes the open dashboard.

Initial data is sampled into the Webview, and dashboard requests can execute DuckDB SQL against the data views. Query results are cached by SQL and data-file fingerprint; changing a file invalidates the cache. Each operation closes its DuckDB connection and instance.
