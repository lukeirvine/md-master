import * as vscode from 'vscode';
import * as path from 'path';

export const VIEW_TYPE = 'mdMaster.editor';

type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'flushed'; id: number; text: string | null }
  | { type: 'openLink'; href: string }
  | { type: 'pickImage'; id: number }
  | { type: 'pasteImage'; id: number; data: string; ext: string }
  | { type: 'openRaw' }
  | { type: 'scroll'; anchor: number; frac: number; atTop: boolean };

type DiffRole = 'original' | 'modified';

/** One webview showing one document. Two sessions get paired when shown as a diff. */
interface Session {
  document: vscode.TextDocument;
  panel: vscode.WebviewPanel;
  post: (msg: unknown) => void;
  ready: boolean;
  readOnly: boolean;
  createdAt: number;
  partner?: Session;
  role?: DiffRole;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function toPosixRelative(fromDir: vscode.Uri, file: vscode.Uri): string {
  const rel = path.posix.relative(fromDir.path, file.path);
  // Encode characters that would break a markdown link target.
  return rel.split('/').map((seg) => encodeURIComponent(seg).replace(/%40/g, '@')).join('/');
}

function isWritable(doc: vscode.TextDocument): boolean {
  if (doc.isUntitled) return true;
  return vscode.workspace.fs.isWritableFileSystem(doc.uri.scheme) === true;
}

/** `git:` URIs carry the real path and ref as JSON in the query. */
function gitInfo(uri: vscode.Uri): { path: string; ref: string } | null {
  if (uri.scheme !== 'git') return null;
  try {
    const q = JSON.parse(uri.query);
    return { path: q.path ?? uri.fsPath, ref: q.ref ?? '' };
  } catch {
    return { path: uri.fsPath, ref: '' };
  }
}

function labelFor(doc: vscode.TextDocument, partner: vscode.TextDocument): string {
  const name = path.basename(doc.uri.path);
  const git = gitInfo(doc.uri);
  if (git) {
    const ref = git.ref;
    if (ref === '~' || ref === '') return `${name} · Before`;
    if (ref === 'HEAD') return `${name} · HEAD`;
    return `${name} · ${/^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, 7) : ref}`;
  }
  if (doc.uri.scheme === 'file' && gitInfo(partner.uri)) return `${name} · Working tree`;
  if (doc.uri.scheme === 'file') return name;
  return `${name} · ${doc.uri.scheme}`;
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(VIEW_TYPE, new MarkdownEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  private sessions = new Set<Session>();

  constructor(private readonly context: vscode.ExtensionContext) {
    // Keep the "other side" of every diff up to date as either document changes.
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length === 0) return;
        for (const s of this.sessions) {
          if (s.partner && s.partner.document === e.document && s.ready) {
            s.post({ type: 'diffOther', text: e.document.getText() });
          }
        }
      }),
    );
  }

  // ------------------------------------------------------------------ entry points

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session = this.setup(document, panel);
    this.tryHeuristicPair(session);
  }

  /**
   * Proposed API (`customEditorDiffs`): VS Code hands us both halves of a diff at once.
   * Only called when the proposal is enabled for this extension; otherwise VS Code opens
   * two plain editors and we fall back to `tryHeuristicPair`.
   */
  async resolveCustomTextEditorSideBySideDiff(
    documents: { original: vscode.TextDocument; modified: vscode.TextDocument },
    panels: { original: vscode.WebviewPanel; modified: vscode.WebviewPanel },
  ): Promise<void> {
    const original = this.setup(documents.original, panels.original);
    const modified = this.setup(documents.modified, panels.modified);
    this.pair(original, modified);
  }

  // ------------------------------------------------------------------ diff pairing

  private pair(original: Session, modified: Session) {
    original.partner = modified;
    modified.partner = original;
    original.role = 'original';
    modified.role = 'modified';
    this.sendDiff(original);
    this.sendDiff(modified);
  }

  private sendDiff(s: Session) {
    if (!s.ready || !s.partner || !s.role) return;
    s.post({
      type: 'diff',
      role: s.role,
      otherText: s.partner.document.getText(),
      label: labelFor(s.document, s.partner.document),
      readOnly: s.readOnly,
    });
  }

  /**
   * Without the proposed API, a git diff shows up as two unrelated editors opened at the
   * same moment in the same group: a read-only `git:` one and the real file. Pair those.
   */
  private tryHeuristicPair(s: Session) {
    const attempt = () => {
      if (s.partner || !this.sessions.has(s)) return true;
      const mine = gitInfo(s.document.uri);
      for (const o of this.sessions) {
        if (o === s || o.partner || Math.abs(o.createdAt - s.createdAt) > 3000) continue;
        if (o.panel.viewColumn !== s.panel.viewColumn) continue;
        const theirs = gitInfo(o.document.uri);
        if (mine && !theirs && o.document.uri.scheme === 'file' && o.document.uri.fsPath === mine.path) {
          this.pair(s, o);
          return true;
        }
        if (theirs && !mine && s.document.uri.scheme === 'file' && s.document.uri.fsPath === theirs.path) {
          this.pair(o, s);
          return true;
        }
      }
      return false;
    };
    if (!attempt()) setTimeout(attempt, 400);
  }

  // ------------------------------------------------------------------ session

  private setup(document: vscode.TextDocument, panel: vscode.WebviewPanel): Session {
    const webview = panel.webview;
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const distDir = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const roots = [distDir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    if (docDir.scheme === 'file') roots.push(docDir);

    webview.options = { enableScripts: true, localResourceRoots: roots };
    webview.html = this.getHtml(webview, distDir);

    const session: Session = {
      document,
      panel,
      post: (msg) => void webview.postMessage(msg),
      ready: false,
      readOnly: !isWritable(document),
      createdAt: Date.now(),
    };
    this.sessions.add(session);
    const post = session.post;

    const disposables: vscode.Disposable[] = [];
    // Texts we wrote to the document ourselves. When the change event for one
    // of these comes back, we must NOT push it back into the webview (that is
    // what makes other editors jump the cursor / eat keystrokes).
    let pending: string[] = [];
    let editQueue: Promise<unknown> = Promise.resolve();
    let flushId = 0;
    const flushWaiters = new Map<number, (text: string | null) => void>();

    const settings = () => {
      const cfg = vscode.workspace.getConfiguration('mdMaster');
      return {
        maxWidth: cfg.get<number>('maxWidth', 760),
        fontFamily: cfg.get<string>('fontFamily', ''),
        fontSize: cfg.get<number>('fontSize', 16),
      };
    };

    const fullRange = () => new vscode.Range(0, 0, document.lineCount, 0);

    // Images in a git revision still live next to the real file.
    const imageBase = () => {
      const git = gitInfo(document.uri);
      const dir = git ? vscode.Uri.joinPath(vscode.Uri.file(git.path), '..') : docDir;
      return webview.asWebviewUri(dir).toString();
    };

    const applyText = (text: string) => {
      if (session.readOnly) return editQueue;
      editQueue = editQueue.then(async () => {
        if (text === document.getText()) return;
        pending.push(text);
        if (pending.length > 50) pending = pending.slice(-50);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, fullRange(), text);
        const ok = await vscode.workspace.applyEdit(edit);
        if (!ok) pending = pending.filter((t) => t !== text);
      });
      return editQueue;
    };

    const requestFlush = (timeoutMs = 1500) =>
      new Promise<string | null>((resolve) => {
        const id = ++flushId;
        const timer = setTimeout(() => {
          flushWaiters.delete(id);
          resolve(null);
        }, timeoutMs);
        flushWaiters.set(id, (text) => {
          clearTimeout(timer);
          resolve(text);
        });
        post({ type: 'flush', id });
      });

    disposables.push(
      webview.onDidReceiveMessage(async (msg: FromWebview) => {
        switch (msg.type) {
          case 'ready': {
            session.ready = true;
            post({
              type: 'init',
              text: document.getText(),
              baseUri: imageBase(),
              settings: settings(),
              fileName: path.basename(document.uri.path),
              readOnly: session.readOnly,
            });
            this.sendDiff(session);
            break;
          }
          case 'edit':
            void applyText(msg.text);
            break;
          case 'flushed':
            flushWaiters.get(msg.id)?.(msg.text);
            flushWaiters.delete(msg.id);
            break;
          case 'openLink':
            await this.openLink(msg.href, docDir);
            break;
          case 'pickImage': {
            const src = await this.pickImage(docDir);
            post({ type: 'imagePicked', id: msg.id, src });
            break;
          }
          case 'pasteImage': {
            const src = await this.savePastedImage(document.uri, docDir, msg.data, msg.ext);
            post({ type: 'imagePicked', id: msg.id, src });
            break;
          }
          case 'openRaw':
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            break;
          case 'scroll':
            if (session.partner?.ready) session.partner.post({ ...msg, type: 'syncScroll' });
            break;
        }
      }),

      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        if (e.contentChanges.length === 0) return;
        const text = document.getText();
        const idx = pending.indexOf(text);
        if (idx !== -1) {
          pending = pending.slice(idx + 1);
          return;
        }
        // Change came from somewhere else (git, raw text editor, undo via menu...)
        pending = [];
        if (session.ready) post({ type: 'external', text });
      }),

      vscode.workspace.onWillSaveTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString() || !session.ready || session.readOnly) return;
        // Make sure the very latest keystrokes are in the document before it is written.
        e.waitUntil(
          (async () => {
            const text = await requestFlush();
            await editQueue;
            if (text === null || text === document.getText()) return [];
            pending.push(text);
            return [vscode.TextEdit.replace(fullRange(), text)];
          })(),
        );
      }),

      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mdMaster')) post({ type: 'settings', settings: settings() });
      }),
    );

    panel.onDidDispose(() => {
      disposables.forEach((d) => d.dispose());
      this.sessions.delete(session);
      const partner = session.partner;
      if (partner) {
        partner.partner = undefined;
        partner.role = undefined;
        if (partner.ready) partner.post({ type: 'diffEnd' });
      }
    });

    return session;
  }

  // ------------------------------------------------------------------ host helpers

  private async openLink(href: string, docDir: vscode.Uri) {
    if (!href) return;
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(href);
    if (hasScheme && !/^file:/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    let target: vscode.Uri;
    if (hasScheme) {
      target = vscode.Uri.parse(href);
    } else {
      const [p] = href.split('#');
      if (!p) return; // pure anchor, handled in the webview
      const decoded = decodeURIComponent(p);
      const root = vscode.workspace.getWorkspaceFolder(docDir)?.uri ?? docDir;
      target = decoded.startsWith('/') ? vscode.Uri.joinPath(root, decoded) : vscode.Uri.joinPath(docDir, decoded);
    }
    try {
      await vscode.workspace.fs.stat(target);
      await vscode.commands.executeCommand('vscode.open', target);
    } catch {
      vscode.window.showWarningMessage(`MD Master: couldn't find ${href}`);
    }
  }

  private async pickImage(docDir: vscode.Uri): Promise<string | null> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(file-media) Choose a file…', id: 'file' },
        { label: '$(link) Embed a link…', id: 'url' },
      ],
      { placeHolder: 'Add an image' },
    );
    if (!choice) return null;
    if (choice.id === 'url') {
      const url = await vscode.window.showInputBox({ prompt: 'Image URL', placeHolder: 'https://…' });
      return url?.trim() || null;
    }
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      defaultUri: docDir,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp'] },
    });
    if (!files?.[0]) return null;
    return toPosixRelative(docDir, files[0]);
  }

  private async savePastedImage(
    docUri: vscode.Uri,
    docDir: vscode.Uri,
    base64: string,
    ext: string,
  ): Promise<string | null> {
    try {
      const safeExt = /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : 'png';
      const base = path.basename(docUri.path).replace(/\.[^.]+$/, '');
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
      const dir = vscode.Uri.joinPath(docDir, 'assets');
      await vscode.workspace.fs.createDirectory(dir);
      const file = vscode.Uri.joinPath(dir, `${base}-${stamp}.${safeExt}`);
      await vscode.workspace.fs.writeFile(file, Buffer.from(base64, 'base64'));
      return toPosixRelative(docDir, file);
    } catch (err) {
      vscode.window.showErrorMessage(`MD Master: couldn't save pasted image (${err})`);
      return null;
    }
  }

  private getHtml(webview: vscode.Webview, distDir: vscode.Uri): string {
    const nonce = getNonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distDir, 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <div id="diffbar" hidden></div>
  <main id="page">
    <div id="frontmatter"></div>
    <div id="editor"></div>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
