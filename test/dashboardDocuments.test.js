const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { listDashboardDocuments } = require("../out/dashboardService");

test("lists only direct files in the dashboard Documents folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-documents-"));
  const documents = path.join(root, "Documents");
  fs.mkdirSync(path.join(documents, "nested"), { recursive: true });
  fs.writeFileSync(path.join(documents, "z-report.pdf"), "pdf");
  fs.writeFileSync(path.join(documents, "a-notes.docx"), "docx");
  fs.writeFileSync(path.join(documents, "nested", "ignored.txt"), "nested");

  try {
    assert.deepEqual(
      listDashboardDocuments(root).map((document) => document.name),
      ["a-notes.docx", "z-report.pdf"]
    );
    assert.deepEqual(listDashboardDocuments(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores a Documents path that is a file rather than a folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-documents-file-"));
  fs.writeFileSync(path.join(root, "Documents"), "not a folder");
  try {
    assert.deepEqual(listDashboardDocuments(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
