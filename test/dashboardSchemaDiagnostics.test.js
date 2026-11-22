const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDbService } = require("../out/duckdbService");

function createDashboard(root, manifest, dataFiles) {
  const dashboardPath = path.join(root, "dashboard");
  const dataPath = path.join(dashboardPath, "data");
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify(manifest));
  for (const [name, contents] of Object.entries(dataFiles)) {
    fs.writeFileSync(path.join(dataPath, name), contents);
  }
  return dashboardPath;
}

test("checks declared datasets and columns and reports missing schema elements", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-schema-diagnostics-"));
  const dashboardPath = createDashboard(root, {
    dataSources: [{ name: "sales", type: "csv", path: "data/sales.csv" }],
    expectedSchema: [
      { dataset: "sales", columns: ["id", "amount"] },
      { dataset: "warehouse: customers", columns: ["customer_id"] }
    ]
  }, {
    "sales.csv": "id,name\n1,Ada\n"
  });

  try {
    const result = await new DuckDbService().diagnoseSchema(dashboardPath);

    assert.equal(result.configured, true);
    assert.deepEqual(result.checks.map(({ status, missingColumns }) => ({ status, missingColumns })), [
      { status: "missing-columns", missingColumns: ["amount"] },
      { status: "missing-dataset", missingColumns: [] }
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not compare schemas when expectedSchema is not declared", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-schema-optional-"));
  const dashboardPath = createDashboard(root, {}, {
    "sales.csv": "id,name\n1,Ada\n"
  });

  try {
    const result = await new DuckDbService().diagnoseSchema(dashboardPath);

    assert.equal(result.configured, false);
    assert.deepEqual(result.checks, []);
    assert.deepEqual(result.datasets[0].columns, ["id", "name"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skips expected checks when a dataset schema cannot be inspected", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-schema-unavailable-"));
  const dashboardPath = createDashboard(root, {
    expectedSchema: [{ dataset: "broken.duckdb: expected_table", columns: ["id"] }]
  }, {
    "broken.duckdb": "not a DuckDB database"
  });

  try {
    const result = await new DuckDbService().diagnoseSchema(dashboardPath);

    assert.equal(result.checks[0].status, "skipped");
    assert.ok(result.checks[0].error);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("skips expected checks when no data files are available", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-schema-empty-"));
  const dashboardPath = createDashboard(root, {
    expectedSchema: [{ dataset: "sales", columns: ["id"] }]
  }, {});

  try {
    const result = await new DuckDbService().diagnoseSchema(dashboardPath);

    assert.equal(result.checks[0].status, "skipped");
    assert.equal(result.checks[0].error, "no-data-files");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
