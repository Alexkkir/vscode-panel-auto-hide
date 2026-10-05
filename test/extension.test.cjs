const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionSource = fs.readFileSync(
  path.join(__dirname, "../dist/extension.js"),
  "utf8",
);

function createHarness(initialPanelState, initiallyEnabled = true) {
  let panelState = initialPanelState;
  let enabled = initiallyEnabled;
  let editorChanged;
  const commands = [];
  const states = [];
  const vscode = {
    commands: {
      executeCommand(command) {
        // Model state at each public command boundary. VS Code manages the
        // internal layout transitions performed by an individual command.
        commands.push(command);
        if (command === "workbench.action.closePanel") {
          panelState = "hidden";
        } else if (command === "workbench.action.toggleMaximizedPanel") {
          // Maximizing a hidden panel opens it, so every command-induced state
          // must be observed rather than checking only the final state.
          panelState = panelState === "maximized" ? "normal" : "maximized";
        } else {
          throw new Error(`Unexpected command: ${command}`);
        }
        states.push(panelState);
        return Promise.resolve();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "panelAutoHide");
        return {
          get(key, defaultValue) {
            assert.equal(key, "enabled");
            assert.equal(defaultValue, true);
            return enabled;
          },
        };
      },
    },
    window: {
      onDidChangeActiveTextEditor(listener) {
        editorChanged = listener;
        return { dispose() {} };
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(extensionSource, {
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, "vscode");
      return vscode;
    },
    console,
  }, { filename: "dist/extension.js" });
  const context = { subscriptions: [] };
  module.exports.activate(context);
  assert.equal(typeof editorChanged, "function");
  assert.equal(context.subscriptions.length, 1);

  return {
    get panelState() { return panelState; },
    set enabled(value) { enabled = value; },
    commands,
    async openFile(fileName) {
      const stateOffset = states.length;
      const commandOffset = commands.length;
      editorChanged(fileName === undefined ? undefined : {
        document: { fileName },
      });
      // The event handler starts asynchronous work without returning it.
      // Drain its promise continuations without relying on a timed sleep.
      await new Promise((resolve) => setImmediate(resolve));
      return {
        states: states.slice(stateOffset),
        commands: commands.slice(commandOffset),
      };
    },
  };
}

test("switching from a.txt to b.txt closes a half-height panel without flashing", async () => {
  const harness = createHarness("normal");
  const result = await harness.openFile("b.txt");

  assert.deepEqual(result.states, ["hidden"]);
  assert.deepEqual(result.commands, ["workbench.action.closePanel"]);
  assert.equal(harness.panelState, "hidden");

  for (const fileName of ["c.txt", "d.txt"]) {
    const next = await harness.openFile(fileName);
    assert.ok(next.states.every((state) => state === "hidden"), `${fileName} reopened the panel`);
    assert.equal(harness.panelState, "hidden");
  }
});

test("switching editors never reopens an already hidden panel", async () => {
  const harness = createHarness("hidden");

  for (const fileName of ["b.txt", "c.txt", "d.txt"]) {
    const result = await harness.openFile(fileName);
    assert.ok(result.states.every((state) => state === "hidden"), `${fileName} reopened the panel`);
    assert.equal(harness.panelState, "hidden");
  }
});

test("a maximized panel closes directly when the editor changes", async () => {
  const harness = createHarness("maximized");
  const result = await harness.openFile("b.txt");

  assert.deepEqual(result.states, ["hidden"]);
  assert.deepEqual(result.commands, ["workbench.action.closePanel"]);
  assert.equal(harness.panelState, "hidden");
});

test("disabled auto-hide leaves every panel state untouched", async () => {
  for (const panelState of ["normal", "maximized", "hidden"]) {
    const harness = createHarness(panelState, false);
    const result = await harness.openFile("b.txt");

    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.states, []);
    assert.equal(harness.panelState, panelState);
  }
});

test("an absent active editor leaves the panel untouched", async () => {
  const harness = createHarness("normal");
  const result = await harness.openFile(undefined);

  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.states, []);
  assert.equal(harness.panelState, "normal");
});

test("configuration changes are honored on the next editor change", async () => {
  const harness = createHarness("normal", false);
  await harness.openFile("b.txt");
  assert.equal(harness.panelState, "normal");

  harness.enabled = true;
  const enabledResult = await harness.openFile("c.txt");
  assert.deepEqual(enabledResult.states, ["hidden"]);

  harness.enabled = false;
  const disabledResult = await harness.openFile("d.txt");
  assert.deepEqual(disabledResult.commands, []);
  assert.equal(harness.panelState, "hidden");
});
