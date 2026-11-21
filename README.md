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

## Optional local data copies

The `f4datadashb.localCopy` setting is `off` by default, preserving the existing behavior. It applies to dashboards using the conventional `data/` directory; dashboards with a `dataSources` property continue to use those configured paths directly.

- `off`: always read from the original location.
- `auto`: copy `data/` only when its path is detected on a network filesystem and the total size is at least `f4datadashb.localCopyThresholdMb` (default `50`).
- `always`: create a local copy for any conventional `data/` directory.

DuckDB files are copied with DuckDB's read-only database-copy operation into a temporary local directory, then promoted only after the copy succeeds and a table row count has been checked. DuckDB handles any WAL state when it opens the source; a raw WAL sidecar is not paired with the new snapshot. Other files are streamed to temporary files, hashed, and renamed after completion. If copying is cancelled, the dashboard opens against the original data. Copy errors offer a retry or the option to use the original source. Ensure no external process is writing to a non-DuckDB data file while it is being copied.

`f4datadashb.localCopyKeep` controls retention: `session` removes a snapshot when the last dashboard using it in that VS Code extension process closes; `days:N` (default `days:7`) keeps it for N days after last use so it can be reused. A PID lock protects snapshots used by another VS Code window. Old snapshots and stale locks are cleaned on startup when local copies are enabled. Use **F4Data Dashboards: Clear Unused Local Data Copies** to remove inactive copies manually; active copies are left alone.

When a source changes while a dashboard is open, it keeps using its current snapshot and offers **Update local copy** instead of silently recopying a large database. The extension stores snapshots outside the dashboard and its data folder: in `%LOCALAPPDATA%` on Windows, `~/Library/Caches` on macOS, and `$XDG_CACHE_HOME` or `~/.cache` on Linux.

## Reusing DuckDB connections

`f4datadashb.reuseDuckDbInstance` is `false` by default, preserving the existing per-operation connection lifecycle. When enabled, a dashboard reuses one DuckDB instance, prepares its views/attachments once, and uses a bounded pool of connections for concurrent queries.

- `f4datadashb.duckdbMaxConcurrency` limits simultaneous connections (default `4`).
- `f4datadashb.duckdbIdleReleaseSeconds` closes an idle instance after 120 seconds by default; `0` disables the timeout.
- `f4datadashb.previewRows` controls initial samples (default `100`, preserving the existing message shape); set it to `0` to return column names without sample rows.
- Use **F4Data Dashboards: Release Dashboard Database** before replacing a DuckDB file while its dashboard is open. The command closes the current instance; the next query opens the updated file. If local copies are enabled, use **Update local copy** after replacing the source.

Reusing an instance retains DuckDB's native memory and may keep database files open while the dashboard is active. The actual memory overhead and speedup depend on the database and query workload; no UNC benchmark or stable cross-platform memory measurement was available for this change. The setting is therefore opt-in.

Initial column names are obtained with `DESCRIBE`; an optional sample is then fetched up to `previewRows`. If one data file cannot be opened, its dataset reports an error while other valid sources remain available. Data watcher events are debounced for one second, and WAL/temporary-file events are ignored.

Query results and initial previews share an 8 MiB byte-bounded LRU cache. Oversized individual results are returned but not cached, and concurrent identical operations share the same in-flight DuckDB work.

Dashboard queries are streamed up to `f4datadashb.maxRows` (default `10000`, maximum `100000`); responses indicate whether they were truncated. A dashboard can send `cancelQuery` with the matching `requestId` to interrupt a running query. The optional `f4datadashb.pauseWhenHidden` setting (default `false`) cancels active queries and defers watcher-driven refreshes while its Webview is hidden, then refreshes when it becomes visible.

Source fingerprints include file identity and change times as well as size and modification time, so atomically replacing a data file invalidates stale query and session caches even when its size and modification time are preserved. Concurrent VS Code windows can share a completed local copy; a competing copy operation verifies and leases the winner rather than failing on publication.
