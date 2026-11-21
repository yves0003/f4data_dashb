const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDbService } = require("../out/duckdbService");

function createDashboard(root) {
  const dashboard = path.join(root, "dashboard");
  fs.mkdirSync(path.join(dashboard, "data"), { recursive: true });
  fs.writeFileSync(path.join(dashboard, "package.json"), JSON.stringify({ name: "query-limit-test" }));
  return dashboard;
}

test("returns all rows by default and when maxRows is zero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-query-unlimited-"));
  const dashboard = createDashboard(root);
  const service = new DuckDbService();
  try {
    const defaultResult = await service.query(
      dashboard,
      "SELECT i FROM range(1000) AS values(i) ORDER BY i"
    );
    assert.equal(defaultResult.rows.length, 1000);
    assert.equal(defaultResult.truncated, false);
    assert.equal(defaultResult.maxRows, 0);

    const explicitUnlimited = await service.query(
      dashboard,
      "SELECT i FROM range(1000) AS values(i) ORDER BY i",
      false,
      undefined,
      undefined,
      { maxRows: 0 }
    );
    assert.equal(explicitUnlimited.rows.length, 1000);
    assert.equal(explicitUnlimited.truncated, false);
    assert.equal(explicitUnlimited.maxRows, 0);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("returns only the configured query row limit and indicates truncation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-query-limit-"));
  const dashboard = createDashboard(root);
  const service = new DuckDbService();
  try {
    const result = await service.query(
      dashboard,
      "SELECT i FROM range(1000) AS values(i) ORDER BY i",
      false,
      undefined,
      undefined,
      { maxRows: 10 }
    );
    assert.equal(result.rows.length, 10);
    assert.equal(result.truncated, true);
    assert.equal(result.maxRows, 10);

    const smaller = await service.query(
      dashboard,
      "SELECT i FROM range(1000) AS values(i) ORDER BY i",
      false,
      undefined,
      undefined,
      { maxRows: 5 }
    );
    assert.equal(smaller.rows.length, 5);
    assert.equal(smaller.truncated, true);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("interrupts a running DuckDB query when its signal is aborted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-query-cancel-"));
  const dashboard = createDashboard(root);
  const service = new DuckDbService();
  const controller = new AbortController();
  try {
    const query = service.query(
      dashboard,
      "SELECT sum(i) FROM range(1000000000) AS values(i)",
      false,
      undefined,
      undefined,
      { maxRows: 10, signal: controller.signal }
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(query, /query cancelled/i);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
