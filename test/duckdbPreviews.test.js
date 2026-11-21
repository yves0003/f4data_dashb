const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDBInstance } = require("@duckdb/node-api");
const { DuckDbService, isRelevantDataChange } = require("../out/duckdbService");

test("DESCRIBE provides columns with zero previews and a bad DuckDB file stays isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-preview-schema-"));
  let instance;
  try {
    const dashboard = path.join(root, "dashboard");
    const data = path.join(dashboard, "data");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(dashboard, "package.json"), JSON.stringify({ name: "preview-test" }));
    fs.writeFileSync(path.join(data, "valid.csv"), "id,label\n1,one\n2,two\n");

    instance = await DuckDBInstance.create(path.join(data, "invalid.duckdb"));
    const writer = await instance.connect();
    const create = await writer.run("CREATE TABLE sample AS SELECT 1 AS id");
    create.closeSync();
    writer.closeSync();
    instance.closeSync();
    instance = undefined;
    fs.writeFileSync(path.join(data, "invalid.duckdb"), "not a DuckDB database");

    const service = new DuckDbService();
    const noPreview = await service.loadInitialData(dashboard, true, undefined, undefined, 0);
    const invalid = noPreview.datasets.find((dataset) => dataset.name === "invalid.duckdb");
    const valid = noPreview.datasets.find((dataset) => dataset.name === "valid.csv");
    assert.match(invalid.error, /not a valid DuckDB database/i);
    assert.deepEqual(valid.columns, ["id", "label"]);
    assert.deepEqual(valid.rows, []);

    const oneRowPreview = await service.loadInitialData(dashboard, true, undefined, undefined, 1);
    const validWithRow = oneRowPreview.datasets.find((dataset) => dataset.name === "valid.csv");
    assert.deepEqual(validWithRow.columns, ["id", "label"]);
    assert.deepEqual(validWithRow.rows, [{ id: "1", label: "one" }]);
  } finally {
    instance?.closeSync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("defaults to 100 preview rows for compatibility", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-preview-default-"));
  try {
    const dashboard = path.join(root, "dashboard");
    const data = path.join(dashboard, "data");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(dashboard, "package.json"), JSON.stringify({ name: "default-preview-test" }));
    fs.writeFileSync(
      path.join(data, "rows.csv"),
      `id\n${Array.from({ length: 125 }, (_, index) => index).join("\n")}\n`
    );
    const initialData = await new DuckDbService().loadInitialData(dashboard);
    assert.equal(initialData.datasets[0].rows.length, 100);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("filters noisy and temporary data watcher events", () => {
  assert.equal(isRelevantDataChange("report.csv"), true);
  assert.equal(isRelevantDataChange("source.duckdb"), true);
  assert.equal(isRelevantDataChange("source.duckdb.wal"), false);
  assert.equal(isRelevantDataChange("source.csv.partial"), false);
  assert.equal(isRelevantDataChange("~$source.csv"), false);
  assert.equal(isRelevantDataChange("metadata.tmp"), false);
});
