const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDBInstance } = require("@duckdb/node-api");
const {
  getLocalCacheRoot,
  isNetworkPath,
  isNetworkPathByMountTable,
  LocalCopyService,
  parseMountTable
} = require("../out/localCopyService");
const { DuckDbService } = require("../out/duckdbService");

function createToken(cancelled = false) {
  return {
    isCancellationRequested: cancelled,
    onCancellationRequested: () => ({ dispose() {} })
  };
}

function createDashboard(root) {
  const dashboardPath = path.join(root, "dashboard");
  const dataPath = path.join(dashboardPath, "data");
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ name: "test-dashboard" }));
  return { dashboardPath, dataPath };
}

test("resolves non-roaming cache paths for each platform", () => {
  assert.equal(
    getLocalCacheRoot("win32", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test"),
    "C:\\Users\\test\\AppData\\Local\\yves0003.f4datadashb\\copies"
  );
  assert.equal(
    getLocalCacheRoot("darwin", {}, "/Users/test"),
    "/Users/test/Library/Caches/yves0003.f4datadashb/copies"
  );
  assert.equal(
    getLocalCacheRoot("linux", { XDG_CACHE_HOME: "/tmp/cache" }, "/home/test"),
    "/tmp/cache/yves0003.f4datadashb/copies"
  );
  assert.throws(() => getLocalCacheRoot("win32", {}, "C:\\Users\\test"), /LOCALAPPDATA/);
});

test("detects UNC, mapped network drives, local drives, and network mount points", async () => {
  assert.equal(await isNetworkPath("\\\\server\\share\\data", "win32"), true);
  assert.equal(await isNetworkPath("//server/share/data", "linux"), true);
  assert.equal(await isNetworkPath("Z:\\data", "win32", {
    getDriveType: async () => 4
  }), true);
  assert.equal(await isNetworkPath("C:\\data", "win32", {
    getDriveType: async () => 3
  }), false);

  const mountTable = [
    "server:/data /mnt/shared\\040data nfs rw 0 0",
    "/dev/sda1 /mnt ext4 rw 0 0"
  ].join("\n");
  assert.deepEqual(parseMountTable(mountTable), [
    { mountPoint: "/mnt/shared data", type: "nfs" },
    { mountPoint: "/mnt", type: "ext4" }
  ]);
  assert.equal(await isNetworkPath("/mnt/shared data/db.duckdb", "linux", { mountTable }), true);
  assert.equal(await isNetworkPath("/mnt/local/db.duckdb", "linux", { mountTable }), false);
  assert.equal(isNetworkPathByMountTable("/mnt/shared/file", [
    { mountPoint: "/mnt", type: "nfs" },
    { mountPoint: "/mnt/shared", type: "ext4" }
  ]), false);
});

test("creates a consistent local DuckDB snapshot and removes session copies after the last lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-local-copy-"));
  const cacheRoot = path.join(root, "cache");
  let sourceInstance;
  let firstLease;
  let secondLease;
  try {
    const { dashboardPath, dataPath } = createDashboard(root);
    const sourcePath = path.join(dataPath, "large.duckdb");
    sourceInstance = await DuckDBInstance.create(sourcePath);
    const sourceConnection = await sourceInstance.connect();
    const createResult = await sourceConnection.run(
      "CREATE TABLE records AS SELECT i::BIGINT AS id FROM range(250000) AS rows(i)"
    );
    createResult.closeSync();
    sourceConnection.closeSync();
    sourceInstance.closeSync();
    sourceInstance = undefined;
    fs.writeFileSync(path.join(dataPath, "lookup.csv"), "id,label\n1,one\n");

    const copies = new LocalCopyService(cacheRoot);
    const options = { mode: "always", thresholdMb: 0, keep: "session" };
    const progress = { report() {} };
    firstLease = await copies.prepare(dashboardPath, options, progress, createToken());
    assert.ok(firstLease);
    assert.notEqual(firstLease.dataPath, dataPath);
    assert.ok(fs.existsSync(path.join(firstLease.dataPath, "large.duckdb")));
    assert.ok(fs.existsSync(path.join(firstLease.dataPath, "lookup.csv")));

    secondLease = await copies.prepare(dashboardPath, options, progress, createToken());
    assert.ok(secondLease);
    assert.equal(secondLease.dataPath, firstLease.dataPath);

    const duckDb = new DuckDbService();
    const query = "SELECT id FROM \"db_0_large\".main.records ORDER BY id";
    const sourceResult = await duckDb.query(
      dashboardPath,
      query,
      true,
      dataPath
    );
    const copyResult = await duckDb.query(dashboardPath, query, true, firstLease.dataPath);
    assert.deepEqual(copyResult.columns, sourceResult.columns);
    assert.deepEqual(copyResult.rows, sourceResult.rows);
    assert.equal(copyResult.rows.length, 250000);

    const activeCopyPath = firstLease.dataPath;
    await firstLease.dispose();
    firstLease = undefined;
    assert.ok(fs.existsSync(activeCopyPath));
    await secondLease.dispose();
    secondLease = undefined;
    assert.equal(fs.existsSync(activeCopyPath), false);
  } finally {
    sourceInstance?.closeSync();
    await firstLease?.dispose();
    await secondLease?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shares a concurrently created copy across callers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-local-copy-race-"));
  const leases = [];
  try {
    const { dashboardPath, dataPath } = createDashboard(root);
    fs.writeFileSync(path.join(dataPath, "records.csv"), "id,label\n1,one\n");
    const copies = new LocalCopyService(path.join(root, "cache"));
    const options = { mode: "always", thresholdMb: 0, keep: "session" };
    const [first, second] = await Promise.all([
      copies.prepare(dashboardPath, options, { report() {} }, createToken()),
      copies.prepare(dashboardPath, options, { report() {} }, createToken())
    ]);
    assert.ok(first);
    assert.ok(second);
    leases.push(first, second);
    assert.equal(first.dataPath, second.dataPath);
    assert.ok(fs.existsSync(path.join(first.dataPath, "records.csv")));
  } finally {
    for (const lease of leases) {
      await lease.dispose();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cancellation returns to source without leaving a partial copy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-local-copy-cancel-"));
  try {
    const { dashboardPath, dataPath } = createDashboard(root);
    fs.writeFileSync(path.join(dataPath, "records.csv"), "id\n1\n");
    const copies = new LocalCopyService(path.join(root, "cache"));
    const lease = await copies.prepare(
      dashboardPath,
      { mode: "always", thresholdMb: 0, keep: "session" },
      { report() {} },
      createToken(true)
    );
    assert.equal(lease, undefined);
    assert.equal(copies.purge("session"), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
