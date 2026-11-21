const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DuckDbService } = require("../out/duckdbService");

test("detects atomic source-file replacement even when size and mtime are unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-file-replace-"));
  const dashboard = path.join(root, "dashboard");
  const data = path.join(dashboard, "data");
  const source = path.join(data, "records.csv");
  const replacement = path.join(data, "records.next");
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(dashboard, "package.json"), JSON.stringify({ name: "replacement-test" }));
  fs.writeFileSync(source, "id,label\n1,old\n");
  const service = new DuckDbService();
  try {
    const query = 'SELECT * FROM "data_0_records_csv"';
    const before = await service.query(dashboard, query);
    assert.equal(before.rows[0].label, "old");

    const originalStat = fs.statSync(source);
    fs.writeFileSync(replacement, "id,label\n2,new\n");
    fs.utimesSync(replacement, originalStat.atime, originalStat.mtime);
    fs.renameSync(replacement, source);

    const after = await service.query(dashboard, query);
    assert.equal(after.rows[0].label, "new");
  } finally {
    await service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
