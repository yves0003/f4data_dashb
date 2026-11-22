# Changelog

## Unreleased

### Dashboard list activation

- Refresh the dashboard list whenever its view becomes visible, so dashboards are reloaded when the user returns to the extension after VS Code startup.
- Coalesce concurrent refresh requests to prevent overlapping reads and state updates.
- Register the dashboard-open command before creating the tree view, so a newly displayed dashboard cannot be clicked before its command handler exists.
- Keep stored paths for dashboards that cannot currently be accessed, preserve their favorites, and retry loading them every 10 seconds until they are available or the extension is deactivated.
- Remove stored entries only when the dashboard is accessible but structurally invalid.
- Show loading, empty, load-error, and temporarily-unavailable states in the dashboard view, with retry actions where applicable.
- Add activation, first-visibility refresh, and rapid repeated-open regression tests.
- Add an optional `expectedSchema` manifest property and a dashboard diagnostic command that reports available datasets/columns and missing expected schema elements.

### Dashboard tabs

- Reuse and reveal the existing dashboard Webview when its tree item is clicked again, including while its first opening is still in progress.
- Pass the stable dashboard path to the row-open command instead of the transient TreeItem object, avoiding stale command arguments during repeated clicks and tree refreshes.
- Show the extension logo on dashboard tabs.
- Added a gear action in the dashboard view title to open this extension's settings.
- Dashboard list items use `screen-full`; favorited dashboards use a star in the main list.

### Dashboard documents

- Added a separate Documents view below the dashboards view in the F4Data sidebar, listing direct files only for the currently selected dashboard.
- Markdown files open in VS Code's Markdown Preview; other documents open in their associated system application. Nested directories are not traversed or listed.
- Markdown previews are locked so different files remain open in separate tabs; reopening the same file reuses its preview.
- Selecting another dashboard updates the Documents view; clearing the tree selection by clicking empty space retains the last selected dashboard's documents.
- Changes to the selected dashboard's `Documents/` folder and its direct files refresh the view automatically.
- Tests verify selected-dashboard switching, direct-file listing, and exclusion of nested files and non-directory paths.

### Dashboard favorites

- Added a separate Favorites view backed by VS Code `globalState`; toggling the star on a dashboard adds or removes it from Favorites.
- The main dashboard list uses a star for favorited dashboards and `screen-full` for other dashboards. Favorites rows use `screen-full`.
- Removing a dashboard from the imported list also removes it from Favorites.

### Generated dashboard guide

- Expanded newly generated `SKILL_GUIDE.md` files with guidance on validating SQL table/column names, handling dropped or changed schema, displaying request errors, limiting or paging large results, cancelling stale queries, and recovering after source changes.

### Markdown preview

- Extended VS Code's built-in Markdown Preview with collapsible sections and GitHub-style task lists.

### Optional local data copies

- Added opt-in local snapshots for dashboards using `data/`. The default remains `off`.
- DuckDB sources use a read-only DuckDB database copy rather than a raw file copy; CSV, TSV, Parquet, and other files are copied through temporary files and promoted only after integrity checks.
- Added network-path detection, cancellable progress, low-disk-space checks, retention, PID locks for concurrent VS Code windows, manual cleanup, and an explicit update action when source files change.
- A local test created and queried a 250,000-row DuckDB table from both the original and copied databases; columns and all returned values matched. No UNC/share benchmark was available in this environment, so no production speedup is claimed.

### Reusable DuckDB sessions

- Added opt-in per-dashboard instance and connection-pool reuse, with a default concurrency cap of four, a 120-second default idle timeout, an explicit database-release command, and extension-deactivation cleanup.
- Automated tests verify that eight concurrent queries can use the attached database, and that invalidation/release permits reopening a changed database. The option remains disabled by default.
- Local benchmark only: for five forced `COUNT(*)` queries against a 1,000,000-row, 18.4 MB DuckDB file, median latency was 16.1 ms with a fresh instance per operation and 1.5 ms with a reused instance; the first reused query took 13.8 ms including initialization. Process RSS rose by 0.8 MiB during this small test, an approximate and workload-specific measurement.
- No after-change UNC benchmark was available. The local result demonstrates a non-negligible reduction in per-operation setup, but does not quantify performance on the user's network share.

### Initial previews and watcher updates

- Added `f4datadashb.previewRows` (default `100` for compatibility; `0` requests only schema), obtain column names through `DESCRIBE`, and isolate an invalid source file to its own dataset error.
- Data-source watcher notifications are debounced by one second and WAL/temporary files are ignored.
- Automated tests check schema-only mode, the default 100-row sample, an invalid DuckDB file alongside a valid CSV, and watcher filtering.

### Bounded result caching

- Query results and initial previews now share an 8 MiB byte-bounded LRU cache; oversized individual results are returned without being retained.
- Concurrent identical operations are deduplicated, and invalidation prevents in-flight stale results from repopulating the cache.
- Automated tests verify concurrent query deduplication, cache reuse, and LRU eviction after the aggregate result size exceeds the budget.

### Query and Webview lifecycle limits

- Added typed validation for incoming and outgoing dashboard messages, legacy request IDs, query cancellation via DuckDB connection interruption, and configurable `f4datadashb.maxRows` (now unlimited by default; positive limits up to 100,000).
- Added opt-in `f4datadashb.pauseWhenHidden` to cancel active queries and defer watcher refreshes while a dashboard is hidden.
- Generated React and native HTML dashboards now cancel superseded queries, ignore stale responses, and indicate truncated results.
- Tests verify bounded query results and active query interruption.

### File replacement and concurrent local copies

- Source fingerprints now include device/inode identity, change time, and birth time, invalidating stale query/session results after atomic file replacement even when size and modification time match.
- Concurrent snapshot publishers verify and reuse a valid winner instead of failing when another VS Code process publishes the same source version first.
- Lock records include the host name so PID checks are scoped to the current machine; older lock records remain readable.
- Tests cover atomic data-file replacement and simultaneous local-copy preparation.
