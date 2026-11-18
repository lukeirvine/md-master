import * as vscode from 'vscode';
import { MarkdownEditorProvider, VIEW_TYPE } from './MarkdownEditorProvider';

function resolveTargetUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    return input.uri;
  }
  return vscode.window.activeTextEditor?.document.uri;
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    MarkdownEditorProvider.register(context),

    vscode.commands.registerCommand('mdMaster.openRaw', async (uri?: vscode.Uri) => {
      const target = resolveTargetUri(uri);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),

    vscode.commands.registerCommand('mdMaster.openEditor', async (uri?: vscode.Uri) => {
      const target = resolveTargetUri(uri);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate() {}
