// Runs only in the isolated Extension Development Host started by smoke-test.cjs.
const http = require('node:http');
const path = require('node:path');
const vscode = require('vscode');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('yoshintame.panel-auto-hide');
  if (!extension) throw new Error('Panel Auto Hide extension was not loaded');
  await extension.activate();
  await new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        const { action, maximized = false } = body ? JSON.parse(body) : {};
        if (action === 'setup') {
          await vscode.workspace.getConfiguration('panelAutoHide').update('enabled', false, true);
          await vscode.workspace.getConfiguration('workbench.panel').update('opensMaximized', 'never', true);
          await vscode.commands.executeCommand('workbench.action.closePanel');
          const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
          await vscode.window.showTextDocument(vscode.Uri.file(path.join(workspace, 'a.txt')));
          await vscode.commands.executeCommand('workbench.action.terminal.new');
          vscode.window.activeTerminal.show();
          await delay(400);
          if (maximized) await vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
          await vscode.workspace.getConfiguration('panelAutoHide').update('enabled', true, true);
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          activeFile: vscode.window.activeTextEditor?.document.uri.fsPath,
          extensionVersion: extension.packageJSON.version,
          terminalCount: vscode.window.terminals.length,
        }));
        if (action === 'stop') setTimeout(() => server.close(resolve), 50);
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error.stack || String(error) }));
      }
    });
    server.on('error', reject);
    server.listen(Number(process.env.PANEL_SMOKE_CONTROL_PORT), '127.0.0.1');
  });
};
