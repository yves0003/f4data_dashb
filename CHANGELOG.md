# Changelog

## Unreleased

### Optional local data copies

- Added opt-in local snapshots for dashboards using `data/`. The default remains `off`.
- DuckDB sources use a read-only DuckDB database copy rather than a raw file copy; CSV, TSV, Parquet, and other files are copied through temporary files and promoted only after integrity checks.
- Added network-path detection, cancellable progress, low-disk-space checks, retention, PID locks for concurrent VS Code windows, manual cleanup, and an explicit update action when source files change.
- A local test created and queried a 250,000-row DuckDB table from both the original and copied databases; columns and all returned values matched. No UNC/share benchmark was available in this environment, so no production speedup is claimed.
