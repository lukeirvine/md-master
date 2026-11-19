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
  const provider = MarkdownEditorProvider.register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('mdMaster.openRaw', async (uri?: vscode.Uri) => {
      const target = resolveTargetUri(uri);
      if (!target) return;
      // Carry the cursor over when switching from an active MD Master tab.
      const selection = await provider.activeSelection(target);
      await vscode.commands.executeCommand('vscode.openWith', target, 'default');
      const ed = vscode.window.activeTextEditor;
      if (selection && ed && ed.document.uri.toString() === target.toString()) {
        const sel = new vscode.Selection(
          ed.document.validatePosition(selection.anchor),
          ed.document.validatePosition(selection.active),
        );
        ed.selection = sel;
        ed.revealRange(sel, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }),

    vscode.commands.registerCommand('mdMaster.toggleOutline', () =>
      provider.setOutlineVisible(!provider.outlineVisible),
    ),

    vscode.commands.registerCommand('mdMaster.openEditor', async (uri?: vscode.Uri) => {
      const target = resolveTargetUri(uri);
      if (!target) return;
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

export function deactivate() {}
