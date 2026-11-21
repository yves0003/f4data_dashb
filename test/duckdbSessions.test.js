const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDBInstance } = require("@duckdb/node-api");
const { DuckDbService } = require("../out/duckdbService");

const sessionOptions = {
  reuseInstance: true,
  idleReleaseSeconds: 0,
  maxConcurrency: 4
};

test("reuses attached databases across concurrent connections and closes on last dashboard release", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-duckdb-session-"));
  let sourceInstance;
  let dashboardLease;
  try {
    const dashboardPath = path.join(root, "dashboard");
    const dataPath = path.join(dashboardPath, "data");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ name: "session-test" }));
    sourceInstance = await DuckDBInstance.create(path.join(dataPath, "records.duckdb"));
    const sourceConnection = await sourceInstance.connect();
    const created = await sourceConnection.run(
      "CREATE TABLE records AS SELECT i::BIGINT AS id FROM range(100000) AS rows(i)"
    );
    created.closeSync();
    sourceConnection.closeSync();
    sourceInstance.closeSync();
    sourceInstance = undefined;

    const service = new DuckDbService();
    dashboardLease = service.retainDashboard(dashboardPath);
    const queries = Array.from({ length: 8 }, (_, index) =>
      service.query(
        dashboardPath,
        `SELECT COUNT(*) AS count FROM "db_0_records".main.records WHERE id % 4 = ${index % 4}`,
        true,
        undefined,
        sessionOptions
      )
    );
    const results = await Promise.all(queries);
    assert.deepEqual(results.map((result) => String(result.rows[0].count)), Array(8).fill("25000"));

    const activeLease = dashboardLease;
    dashboardLease = undefined;
    await activeLease.dispose();

    const afterRelease = await service.query(
      dashboardPath,
      'SELECT COUNT(*) AS count FROM "db_0_records".main.records',
      true,
      undefined,
      sessionOptions
    );
    assert.equal(String(afterRelease.rows[0].count), "100000");
    await service.dispose();
  } finally {
    sourceInstance?.closeSync();
    await dashboardLease?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalidating a dashboard closes its reused DuckDB session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-duckdb-invalidate-"));
  let sourceInstance;
  try {
    const dashboardPath = path.join(root, "dashboard");
    const dataPath = path.join(dashboardPath, "data");
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ name: "invalidate-test" }));
    const databasePath = path.join(dataPath, "records.duckdb");
    sourceInstance = await DuckDBInstance.create(databasePath);
    const writer = await sourceInstance.connect();
    const created = await writer.run("CREATE TABLE records AS SELECT 1 AS id");
    created.closeSync();
    writer.closeSync();
    sourceInstance.closeSync();
    sourceInstance = undefined;

    const service = new DuckDbService();
    const first = await service.query(
      dashboardPath,
      'SELECT COUNT(*) AS count FROM "db_0_records".main.records',
      true,
      undefined,
      sessionOptions
    );
    assert.equal(String(first.rows[0].count), "1");
    await service.invalidate(dashboardPath);

    sourceInstance = await DuckDBInstance.create(databasePath);
    const writerAfterInvalidate = await sourceInstance.connect();
    const changed = await writerAfterInvalidate.run("INSERT INTO records VALUES (2)");
    changed.closeSync();
    writerAfterInvalidate.closeSync();
    sourceInstance.closeSync();
    sourceInstance = undefined;

    const updated = await service.query(
      dashboardPath,
      'SELECT COUNT(*) AS count FROM "db_0_records".main.records',
      true,
      undefined,
      sessionOptions
    );
    assert.equal(String(updated.rows[0].count), "2");
    await service.dispose();
  } finally {
    sourceInstance?.closeSync();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
