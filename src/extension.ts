import * as vscode from "vscode";

function isEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("panelAutoHide")
    .get<boolean>("enabled", true);
}

async function hidePanel() {
  await vscode.commands.executeCommand("workbench.action.closePanel");
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !isEnabled()) {
        return;
      }
      hidePanel();
    }),
  );
}

export function deactivate() {}
