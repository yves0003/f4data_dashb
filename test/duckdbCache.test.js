const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDbService } = require("../out/duckdbService");

function createDashboard(root) {
  const dashboard = path.join(root, "dashboard");
  fs.mkdirSync(dashboard, { recursive: true });
  fs.mkdirSync(path.join(dashboard, "data"));
  fs.writeFileSync(path.join(dashboard, "package.json"), JSON.stringify({ name: "cache-test" }));
  return dashboard;
}

test("deduplicates concurrent identical queries and reuses their result", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-query-dedup-"));
  const dashboard = createDashboard(root);
  const service = new DuckDbService();
  const runWithDatabase = service.withDatabase.bind(service);
  let executions = 0;
  service.withDatabase = (...args) => {
    executions++;
    return new Promise((resolve) => setTimeout(resolve, 25)).then(() => runWithDatabase(...args));
  };

  try {
    const [first, second] = await Promise.all([
      service.query(dashboard, "SELECT 42 AS answer"),
      service.query(dashboard, "SELECT 42 AS answer")
    ]);
    assert.deepEqual(first, second);
    assert.equal(executions, 1);

    await service.query(dashboard, "SELECT 42 AS answer");
    assert.equal(executions, 1);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evicts least-recently-used results when the byte budget is exceeded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-query-lru-"));
  const dashboard = createDashboard(root);
  const service = new DuckDbService();
  const runWithDatabase = service.withDatabase.bind(service);
  let executions = 0;
  service.withDatabase = (...args) => {
    executions++;
    return runWithDatabase(...args);
  };

  try {
    const queries = ["a", "b", "c"].map((character) =>
      `SELECT repeat('${character}', 3000000) AS value`
    );
    await service.query(dashboard, queries[0]);
    await service.query(dashboard, queries[1]);
    await service.query(dashboard, queries[0]);
    await service.query(dashboard, queries[2]);
    assert.equal(executions, 3);

    await service.query(dashboard, queries[0]);
    assert.equal(executions, 3);
    await service.query(dashboard, queries[1]);
    assert.equal(executions, 4);
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
