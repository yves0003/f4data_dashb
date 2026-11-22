const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readStoredDashboards } = require("../out/dashboardService");

function createDashboard(root, name = "Dashboard") {
  const dashboardPath = path.join(root, name);
  fs.mkdirSync(path.join(dashboardPath, "data"), { recursive: true });
  fs.mkdirSync(path.join(dashboardPath, "vue"), { recursive: true });
  fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ displayName: name }));
  fs.writeFileSync(path.join(dashboardPath, "vue", "index.html"), "");
  return dashboardPath;
}

test("keeps unavailable dashboard paths and removes only invalid dashboards", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-dashboard-availability-"));
  const validPath = createDashboard(root);
  const invalidPath = path.join(root, "invalid");
  fs.mkdirSync(invalidPath);
  const unavailablePath = path.join(root, "temporarily-unavailable");

  try {
    const result = readStoredDashboards([validPath, invalidPath, unavailablePath]);

    assert.deepEqual(result.dashboards.map((dashboard) => dashboard.path), [validPath]);
    assert.deepEqual(result.retainedPaths, [validPath, unavailablePath]);
    assert.equal(result.invalidCount, 1);
    assert.equal(result.unavailableCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("treats a malformed package manifest as invalid rather than unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-dashboard-package-"));
  const dashboardPath = createDashboard(root);
  fs.writeFileSync(path.join(dashboardPath, "package.json"), "{");

  try {
    const result = readStoredDashboards([dashboardPath]);

    assert.deepEqual(result.retainedPaths, []);
    assert.equal(result.invalidCount, 1);
    assert.equal(result.unavailableCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
