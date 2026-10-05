#!/usr/bin/env node
// Real Explorer clicks and layout transitions in an isolated installed VS Code.
// Usage: node scripts/smoke-test.cjs [--old-extension=/path/to/0.1.4]
// Set VSCODE_EXECUTABLE and PLAYWRIGHT_MODULE when they are not on the defaults.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const executable = process.env.VSCODE_EXECUTABLE || [
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].find((candidate) => fs.existsSync(candidate));
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to your installed VS Code executable');
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = require(playwrightModule);
const oldArgument = process.argv.find((arg) => arg.startsWith('--old-extension='));
const oldExtension = oldArgument?.slice('--old-extension='.length);
// macOS Unix-domain IPC paths are limited to 103 bytes; its default temp path
// can exceed that once VS Code appends the profile socket name.
const tempRoot = process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
const outputDirectory = fs.mkdtempSync(path.join(tempRoot, 'panel-smoke-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function retry(operation, description) {
  const timeout = Date.now() + 30000;
  let lastError;
  while (Date.now() < timeout) {
    try { return await operation(); } catch (error) { lastError = error; await delay(200); }
  }
  throw new Error(`${description}: ${lastError?.message}`);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const workbench = document.querySelector('.monaco-workbench');
    const panel = document.querySelector('.part.panel');
    const editor = document.querySelector('.part.editor');
    return {
      panelVisible: !workbench.classList.contains('nopanel'),
      maximized: workbench.classList.contains('nomaineditorarea'),
      panelHeight: Math.round(panel.getBoundingClientRect().height),
      editorHeight: Math.round(editor.getBoundingClientRect().height),
      workbenchHeight: Math.round(workbench.getBoundingClientRect().height),
    };
  });
}

async function startTrace(page) {
  await page.evaluate(() => {
    window.panelSmokeObserver?.disconnect();
    const generation = window.panelSmokeGeneration = (window.panelSmokeGeneration || 0) + 1;
    const workbench = document.querySelector('.monaco-workbench');
    const panel = document.querySelector('.part.panel');
    window.panelSmokeTrace = [];
    const sample = (source) => {
      const next = {
        source,
        at: performance.now(),
        panelVisible: !workbench.classList.contains('nopanel'),
        maximized: workbench.classList.contains('nomaineditorarea'),
        panelHeight: Math.round(panel.getBoundingClientRect().height),
      };
      window.panelSmokeTrace.push(next);
    };
    window.panelSmokeObserver = new MutationObserver((mutations) => {
      // Class oldValue preserves a transient maximize even if close runs before
      // the observer callback or the next painted frame.
      for (const mutation of mutations) {
        if (mutation.target === workbench && mutation.attributeName === 'class') {
          window.panelSmokeTrace.push({
            source: 'class-before-mutation', at: performance.now(),
            panelVisible: !mutation.oldValue.split(/\s+/).includes('nopanel'),
            maximized: mutation.oldValue.split(/\s+/).includes('nomaineditorarea'),
          });
        }
      }
      sample('mutation');
    });
    window.panelSmokeObserver.observe(workbench, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    const frame = () => {
      if (!window.panelSmokeTracing || window.panelSmokeGeneration !== generation) return;
      sample('animation-frame');
      requestAnimationFrame(frame);
    };
    window.panelSmokeTracing = true;
    sample('initial');
    requestAnimationFrame(frame);
  });
}

async function finishTrace(page) {
  return page.evaluate(() => {
    window.panelSmokeTracing = false;
    window.panelSmokeObserver.disconnect();
    return window.panelSmokeTrace;
  });
}

async function setHalfHeight(page) {
  const size = await snapshot(page);
  const targetHeight = Math.round((size.panelHeight + size.editorHeight) / 2);
  const sash = await page.evaluate(() => {
    const panel = document.querySelector('.part.panel').getBoundingClientRect();
    const candidates = Array.from(document.querySelectorAll('.monaco-sash.horizontal:not(.disabled)'))
      .map((element) => element.getBoundingClientRect())
      .filter((rect) => rect.height > 0 && rect.width >= panel.width / 2)
      .sort((a, b) => Math.abs(a.y + a.height / 2 - panel.y) - Math.abs(b.y + b.height / 2 - panel.y));
    const rect = candidates[0];
    if (!rect || Math.abs(rect.y + rect.height / 2 - panel.y) > 12) throw new Error('Panel resize sash not found');
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  // Floating panel layouts put the resize sash a few pixels above the panel.
  await page.mouse.move(sash.x, sash.y);
  await page.mouse.down();
  await page.mouse.move(sash.x, sash.y + size.panelHeight - targetHeight, { steps: 8 });
  await page.mouse.up();
  await delay(200);
  const resized = await snapshot(page);
  assert(Math.abs(resized.panelHeight - targetHeight) <= 10, `Panel should be half-height, got ${resized.panelHeight}, expected ${targetHeight}`);
}

async function runVersion(label, extensionPath) {
  const directory = path.join(outputDirectory, label);
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(directory, 'userdata', 'User'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'extensions'), { recursive: true });
  for (const file of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.writeFileSync(path.join(workspace, file), `${file}\n`);
  fs.writeFileSync(path.join(directory, 'userdata', 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'workbench.tips.enabled': false,
    'workbench.enableExperiments': false, 'telemetry.telemetryLevel': 'off',
    'update.mode': 'none', 'extensions.autoUpdate': false,
    'terminal.integrated.enablePersistentSessions': false,
    'window.newWindowDimensions': 'default',
  }));
  const debugPort = await freePort();
  const controlPort = await freePort();
  const logPath = path.join(directory, 'vscode.log');
  const log = fs.createWriteStream(logPath);
  const child = spawn(executable, [
    '--new-window', `--user-data-dir=${path.join(directory, 'userdata')}`,
    `--extensions-dir=${path.join(directory, 'extensions')}`, '--disable-extensions',
    `--extensionDevelopmentPath=${extensionPath}`,
    `--extensionTestsPath=${path.join(__dirname, 'smoke-extension-host.cjs')}`,
    `--remote-debugging-port=${debugPort}`, '--enable-smoke-test-driver',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', workspace,
  ], { env: { ...process.env, PANEL_SMOKE_CONTROL_PORT: String(controlPort) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const childExit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let browser;
  const control = async (action, values = {}) => {
    const response = await fetch(`http://127.0.0.1:${controlPort}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...values }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  };
  try {
    browser = await retry(() => {
      if (spawnError) throw spawnError;
      return chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    }, 'CDP connection');
    const page = await retry(async () => {
      const pages = browser.contexts().flatMap((context) => context.pages());
      for (const candidate of pages) if (await candidate.locator('.monaco-workbench').count()) return candidate;
      throw new Error('Workbench page not ready');
    }, 'Workbench renderer');
    await retry(() => control('status'), 'Extension test host');
    await page.evaluate(() => window.driver.whenWorkbenchRestored());
    const results = [];
    for (const maximized of [false, true]) {
      await control('setup', { maximized });
      if (!maximized) await setHalfHeight(page);
      const initial = await snapshot(page);
      assert.equal(initial.panelVisible, true, `${label}: setup panel visible`);
      assert.equal(initial.maximized, maximized, `${label}: initial maximize state`);
      await page.screenshot({ path: path.join(directory, `${maximized ? 'maximized' : 'half'}-initial.png`) });
      for (const file of ['b.txt', 'c.txt', 'd.txt']) {
        const before = await snapshot(page);
        await startTrace(page);
        const row = page.locator('.explorer-folders-view .monaco-list-row').filter({ has: page.locator('.label-name', { hasText: file }) });
        await row.click();
        await retry(async () => {
          const status = await control('status');
          if (!status.activeFile?.endsWith(path.sep + file)) throw new Error(`Active file: ${status.activeFile}`);
          const state = await snapshot(page);
          if (state.panelVisible || state.maximized) throw new Error('Panel has not closed');
          return status;
        }, `Open ${file} and hide panel`);
        await delay(400);
        const trace = await finishTrace(page);
        const final = await snapshot(page);
        const newMaximization = !before.maximized && trace.some((entry) => entry.maximized);
        const reopenedHiddenPanel = !before.panelVisible && trace.some((entry) => entry.panelVisible);
        const result = { scenario: maximized ? 'maximized' : 'half-height', file, before, final, newMaximization, reopenedHiddenPanel, trace };
        results.push(result);
        console.log(JSON.stringify({ label, scenario: result.scenario, file, newMaximization, reopenedHiddenPanel, final }));
        if (label === 'fixed') {
          assert.equal(newMaximization, false, `Fixed: ${file} must not maximize panel`);
          assert.equal(reopenedHiddenPanel, false, `Fixed: ${file} must not reopen hidden panel`);
        }
      }
      await page.screenshot({ path: path.join(directory, `${maximized ? 'maximized' : 'half'}-final.png`) });
    }
    if (label === 'old') assert(results.some((result) => result.newMaximization && result.reopenedHiddenPanel), 'Old extension should reproduce hidden-panel flicker');
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(results, null, 2));
    await control('stop');
    return { label, results: results.map(({ trace, ...result }) => result) };
  } finally {
    if (browser) await browser.close();
    if (child.exitCode === null) {
      const stopped = await Promise.race([childExit, delay(3000).then(() => null)]);
      if (!stopped) child.kill('SIGTERM');
    }
    log.end();
  }
}

(async () => {
  console.log(`Smoke artifacts: ${outputDirectory}`);
  const results = [];
  if (oldExtension) results.push(await runVersion('old', path.resolve(oldExtension)));
  results.push(await runVersion('fixed', repo));
  fs.writeFileSync(path.join(outputDirectory, 'summary.json'), JSON.stringify(results, null, 2));
  console.log(`PASS: real Explorer smoke tests. Results and screenshots: ${outputDirectory}`);
})().catch((error) => { console.error(error); console.error(`Artifacts: ${outputDirectory}`); process.exitCode = 1; });
