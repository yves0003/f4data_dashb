const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function withVscodeMock(mock, action) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return mock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return action();
  } finally {
    Module._load = originalLoad;
  }
}

function createVscodeStub() {
  class EventEmitter {
    listeners = new Set();
    event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose() {
      this.listeners.clear();
    }
  }
  class TreeItem {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }
  class ThemeIcon {
    constructor(id) {
      this.id = id;
    }
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    ViewColumn: { Active: 1 }
  };
}

test("dashboard tree renders loading, empty, and error states and coalesces refreshes", async () => {
  const vscode = createVscodeStub();
  const { DashboardTreeProvider } = withVscodeMock(
    vscode,
    () => require("../out/dashboardTree")
  );
  const values = new Map([["dashboards", []], ["favoriteDashboards", []]]);
  let releaseUpdate;
  let updates = 0;
  const state = {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => {
      updates++;
      values.set(key, value);
      if (updates === 1) {
        await new Promise((resolve) => { releaseUpdate = resolve; });
      }
    }
  };
  const provider = new DashboardTreeProvider(state, "en");

  assert.equal(provider.getChildren()[0].contextValue, "f4datadashb.dashboardLoading");
  const firstRefresh = provider.refresh();
  const secondRefresh = provider.refresh();
  assert.equal(updates, 1);
  assert.equal(provider.getChildren()[0].contextValue, "f4datadashb.dashboardLoading");
  releaseUpdate();
  await Promise.all([firstRefresh, secondRefresh]);

  const empty = provider.getChildren()[0];
  assert.equal(empty.contextValue, "f4datadashb.dashboardEmpty");
  assert.equal(empty.command.command, "f4datadashb.importDashboard");

  state.update = async () => { throw new Error("state unavailable"); };
  await assert.rejects(provider.refresh(), /state unavailable/);
  const failed = provider.getChildren()[0];
  assert.equal(failed.contextValue, "f4datadashb.dashboardLoadError");
  assert.equal(failed.command.command, "f4datadashb.refreshDashboards");
  provider.dispose();
});

test("favorite dashboards use a star only in the main dashboard view", () => {
  const vscode = createVscodeStub();
  const { DashboardTreeItem } = withVscodeMock(
    vscode,
    () => require("../out/dashboardTree")
  );
  const dashboard = { path: "/dashboard", displayName: "Dashboard" };

  assert.equal(new DashboardTreeItem(dashboard, "en", false).iconPath.id, "screen-full");
  assert.equal(new DashboardTreeItem(dashboard, "en", true).iconPath.id, "star-full");
  assert.equal(new DashboardTreeItem(dashboard, "en", true, true).iconPath.id, "screen-full");
  assert.equal(new DashboardTreeItem(dashboard, "en", true, true).command.command, "f4datadashb.openDashboard");
  assert.deepEqual(new DashboardTreeItem(dashboard, "en", true, true).command.arguments, ["/dashboard"]);
  assert.equal(new DashboardTreeItem(dashboard, "en", true).command.command, "f4datadashb.openDashboard");
  assert.deepEqual(new DashboardTreeItem(dashboard, "en", false).command.arguments, ["/dashboard"]);
});

test("dashboard tree exposes unavailable paths and retains their favorites", async () => {
  const vscode = createVscodeStub();
  const { DashboardTreeProvider } = withVscodeMock(
    vscode,
    () => require("../out/dashboardTree")
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f4data-tree-unavailable-"));
  const dashboardPath = path.join(root, "available");
  fs.mkdirSync(path.join(dashboardPath, "data"), { recursive: true });
  fs.mkdirSync(path.join(dashboardPath, "vue"), { recursive: true });
  fs.writeFileSync(path.join(dashboardPath, "package.json"), JSON.stringify({ displayName: "Available" }));
  fs.writeFileSync(path.join(dashboardPath, "vue", "index.html"), "");
  const unavailablePath = path.join(root, "temporarily-offline");
  const values = new Map([
    ["dashboards", [dashboardPath, unavailablePath]],
    ["favoriteDashboards", [unavailablePath]]
  ]);
  const state = {
    get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
    update: async (key, value) => values.set(key, value)
  };
  const provider = new DashboardTreeProvider(state, "en");

  try {
    await provider.refresh();

    const unavailable = provider.getChildren().find((item) =>
      item.contextValue === "f4datadashb.dashboardUnavailable"
    );
    assert.ok(unavailable);
    assert.equal(unavailable.command.command, "f4datadashb.refreshDashboards");
    assert.match(unavailable.tooltip, /temporarily-offline/);
    assert.deepEqual(values.get("favoriteDashboards"), [path.normalize(unavailablePath)]);
  } finally {
    provider.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rapid repeated dashboard opens share one in-progress panel creation", async () => {
  const vscode = createVscodeStub();
  const { DashboardWebviewManager } = withVscodeMock(
    vscode,
    () => require("../out/dashboardWebview")
  );
  const manager = new DashboardWebviewManager({}, {}, "en", {});
  let createCount = 0;
  let releaseCreation;
  let revealCount = 0;
  manager.createPanel = async function (dashboardPath) {
    createCount++;
    await new Promise((resolve) => { releaseCreation = resolve; });
    this.panels.set(dashboardPath, { reveal: () => { revealCount++; } });
  };

  const first = manager.open("/dashboard", "Dashboard");
  const second = manager.open("/dashboard", "Dashboard");
  assert.equal(createCount, 1);
  releaseCreation();
  await Promise.all([first, second]);
  assert.equal(createCount, 1);
  assert.equal(revealCount, 1);

  await manager.open("/dashboard", "Dashboard");
  assert.equal(revealCount, 2);
});

test("activation registers open command before the view and refreshes on first visibility", async () => {
  const order = [];
  const registeredCommands = new Map();
  const visibilityListeners = [];
  const selectionListeners = [];
  const openedDashboards = [];
  const documentDashboardSelections = [];
  const executedCommands = [];
  const externalUris = [];
  let refreshCount = 0;
  class TreeItem {}
  class DashboardTreeProvider {
    constructor() {}
    getChildren() { return []; }
    setSelectedDashboard() {}
    refresh() {
      refreshCount++;
      return Promise.resolve({ invalidCount: 0, unavailableCount: 0 });
    }
    dispose() {}
  }
  class EmptyProvider {
    constructor() {}
    dispose() {}
  }
  class DocumentsProvider extends EmptyProvider {
    setSelectedDashboard(dashboardPath) {
      documentDashboardSelections.push(dashboardPath);
    }
  }
  class DuckDbService {
    onDidChangeSessions() { return { dispose() {} }; }
    hasDashboardSession() { return false; }
    dispose() {}
  }
  class DashboardWebviewManager {
    async open(dashboardPath) {
      openedDashboards.push(dashboardPath);
    }
  }
  class LocalCopyService {
    purge() {}
  }
  const vscode = {
    commands: {
      registerCommand: (id, handler) => {
        order.push(`register:${id}`);
        registeredCommands.set(id, handler);
        return { dispose() {} };
      },
      executeCommand: async (...args) => executedCommands.push(args)
    },
    env: {
      language: "en",
      openExternal: async (uri) => {
        externalUris.push(uri);
        return true;
      }
    },
    Uri: { file: (fsPath) => ({ fsPath }) },
    window: {
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      createTreeView: (id) => {
        order.push(`view:${id}`);
        return {
          onDidChangeVisibility: (listener) => {
            visibilityListeners.push(listener);
            return { dispose() {} };
          },
          onDidChangeSelection: (listener) => {
            selectionListeners.push(listener);
            return { dispose() {} };
          }
        };
      },
      showErrorMessage() {},
      showWarningMessage() {},
      showInformationMessage() {}
    },
    workspace: { getConfiguration: () => ({}) }
  };
  const replacements = {
    "./dashboardService": {
      findDashboards: () => [],
      normalizePath: (value) => value,
      readDashboard: () => ({ path: "/dashboard", displayName: "Dashboard" })
    },
    "./dashboardTree": {
      DashboardTreeProvider,
      DashboardFavoritesTreeProvider: EmptyProvider,
      DashboardDocumentsTreeProvider: DocumentsProvider,
      DashboardTreeItem: TreeItem
    },
    "./dashboardWebview": { DashboardWebviewManager },
    "./duckdbService": { DuckDbService },
    "./i18n": { translate: (_language, key) => key },
    "./localCopyService": {
      LocalCopyService,
      readLocalCopyOptions: () => ({ mode: "off" })
    }
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    if (Object.prototype.hasOwnProperty.call(replacements, request)) {
      return replacements[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const extension = require("../out/extension");
    const context = {
      globalState: {
        get: (_key, fallback) => fallback,
        update: async () => {}
      },
      subscriptions: [],
      extensionUri: {}
    };
    const markdownExtension = extension.activate(context);
    assert.equal(typeof markdownExtension.extendMarkdownIt, "function");
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      order.indexOf("register:f4datadashb.openDashboard")
        < order.indexOf("view:f4datadashb.dashboards")
    );
    assert.ok(registeredCommands.has("f4datadashb.diagnoseDashboard"));
    assert.ok(registeredCommands.has("f4datadashb.refreshDashboards"));
    assert.equal(refreshCount, 1);
    visibilityListeners[0]({ visible: true });
    assert.equal(refreshCount, 2);
    const selected = new TreeItem();
    selected.dashboard = { path: "/dashboard" };
    selectionListeners[0]({ selection: [selected] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(openedDashboards, []);
    selectionListeners[0]({ selection: [] });
    assert.deepEqual(documentDashboardSelections, ["/dashboard"]);

    await registeredCommands.get("f4datadashb.openDashboard")("/dashboard");
    assert.deepEqual(openedDashboards, ["/dashboard"]);
    assert.deepEqual(documentDashboardSelections, ["/dashboard", "/dashboard"]);
    await registeredCommands.get("f4datadashb.openDashboardDocument")("/documents/readme.MD");
    await registeredCommands.get("f4datadashb.openDashboardDocument")("/documents/report.xlsx");
    assert.deepEqual(executedCommands, [[
      "markdown.showPreview",
      { fsPath: "/documents/readme.MD" },
      undefined,
      { locked: true }
    ]]);
    assert.deepEqual(externalUris, [{ fsPath: "/documents/report.xlsx" }]);
  } finally {
    Module._load = originalLoad;
  }
});
