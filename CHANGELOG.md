# Changelog

## Unreleased

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

- Added typed validation for incoming and outgoing dashboard messages, legacy request IDs, query cancellation via DuckDB connection interruption, and `f4datadashb.maxRows` (default 10,000; maximum 100,000).
- Added opt-in `f4datadashb.pauseWhenHidden` to cancel active queries and defer watcher refreshes while a dashboard is hidden.
- Generated React and native HTML dashboards now cancel superseded queries, ignore stale responses, and indicate truncated results.
- Tests verify bounded query results and active query interruption.
