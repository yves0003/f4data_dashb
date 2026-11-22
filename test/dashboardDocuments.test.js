const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const { listDashboardDocuments } = require("../out/dashboardService");

test("lists only direct files in the dashboard Documents folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-documents-"));
  const documents = path.join(root, "Documents");
  fs.mkdirSync(path.join(documents, "nested"), { recursive: true });
  fs.writeFileSync(path.join(documents, "z-report.pdf"), "pdf");
  fs.writeFileSync(path.join(documents, "a-notes.docx"), "docx");
  fs.writeFileSync(path.join(documents, ".DS_Store"), "metadata");
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

test("documents tree shows only the selected dashboard and follows selection changes", async () => {
  const originalLoad = Module._load;
  const watcherPatterns = [];
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class EventEmitter {
    event() { return { dispose() {} }; }
    fire() {}
    dispose() {}
  }
  class ThemeIcon {
    constructor(id) { this.id = id; }
  }
  class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }
  const vscode = {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    RelativePattern,
    workspace: {
      createFileSystemWatcher: (pattern) => {
        watcherPatterns.push(pattern);
        return {
          onDidCreate: () => ({ dispose() {} }),
          onDidChange: () => ({ dispose() {} }),
          onDidDelete: () => ({ dispose() {} }),
          dispose() {}
        };
      }
    },
    window: { showErrorMessage() {} }
  };
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-documents-selection-"));
  const createDashboard = (name, filename) => {
    const dashboardPath = path.join(root, name);
    fs.mkdirSync(path.join(dashboardPath, "data"), { recursive: true });
    fs.mkdirSync(path.join(dashboardPath, "vue"), { recursive: true });
    fs.mkdirSync(path.join(dashboardPath, "Documents"), { recursive: true });
    fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ name }));
    fs.writeFileSync(path.join(dashboardPath, "vue", "index.html"), "");
    fs.writeFileSync(path.join(dashboardPath, "Documents", filename), "");
    return dashboardPath;
  };
  const firstPath = createDashboard("first", "first.pdf");
  const secondPath = createDashboard("second", "second.pdf");
  try {
    const { DashboardDocumentTreeItem, DashboardDocumentsTreeProvider } = require("../out/dashboardTree");
    const provider = new DashboardDocumentsTreeProvider("en", () => ({ dispose() {} }));

    assert.deepEqual(provider.getChildren(), []);
    provider.setSelectedDashboard(firstPath);
    let roots = provider.getChildren();
    assert.deepEqual(roots.map((item) => item.label), ["first.pdf"]);
    assert.ok(roots[0] instanceof DashboardDocumentTreeItem);
    assert.deepEqual(provider.getChildren(roots[0]), []);
    assert.equal(watcherPatterns.length, 2);

    provider.setSelectedDashboard(secondPath);
    roots = provider.getChildren();
    assert.deepEqual(roots.map((item) => item.label), ["second.pdf"]);
    assert.equal(watcherPatterns.length, 4);

    provider.setSelectedDashboard(undefined);
    assert.deepEqual(provider.getChildren(), []);
    provider.dispose();
  } finally {
    Module._load = originalLoad;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
