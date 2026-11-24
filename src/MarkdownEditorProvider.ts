import * as vscode from 'vscode';
import * as path from 'path';
import { buildDiffHtml, buildHtml, type ExportPane, type ExportTheme, type Snapshot } from './htmlExport';
import { stripColorComments } from '../webview/colorSyntax';

export const VIEW_TYPE = 'mdMaster.editor';
const OUTLINE_KEY = 'mdMaster.outlineVisible';

type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'flushed'; id: number; text: string | null }
  | { type: 'openLink'; href: string }
  | { type: 'pickImage'; id: number }
  | { type: 'pasteImage'; id: number; data: string; ext: string }
  | { type: 'openRaw' }
  | { type: 'outlineVisible'; visible: boolean }
  | { type: 'cursorAt'; id: number; selection: { anchor: SourcePos; head: SourcePos } | null }
  | { type: 'scroll'; anchor: number; frac: number; atTop: boolean }
  | { type: 'snapshotTaken'; id: number; snapshot: Snapshot };

type DiffRole = 'original' | 'modified';

interface SourcePos {
  line: number;
  character: number;
}

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
  /** Where the cursor is in the file's text, once any pending edits have been applied. */
  requestSelection?: () => Promise<vscode.Selection | undefined>;
  /** A static copy of the rendered page, for exporting. */
  requestSnapshot?: (includeOutline: boolean, includeColors: boolean) => Promise<Snapshot | undefined>;
  /** The file's text including edits the webview hasn't sent yet. */
  requestText?: () => Promise<string>;
  /** Folder that relative image paths resolve against. */
  imageDir: vscode.Uri;
  /** Whether this editor's outline sidebar is open. A diff's two sides share one value. */
  outlineVisible: boolean;
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
  static register(context: vscode.ExtensionContext): MarkdownEditorProvider {
    const provider = new MarkdownEditorProvider(context);
    context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        // Find is our own bar (webview/find.ts): VS Code's widget can't show a match count
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }),
    );
    return provider;
  }

  private sessions = new Set<Session>();

  /** Toggle the outline of the editor the command came from (its tab's button or the focused one). */
  toggleOutline(uri?: vscode.Uri) {
    const s = this.currentSession(uri);
    if (s) this.setOutlineVisible(s, !s.outlineVisible);
  }

  /**
   * Per editor: only `s` (and its diff partner, which shares the one outline) changes.
   * The last choice is remembered as the starting state for editors opened later.
   */
  private setOutlineVisible(s: Session, visible: boolean) {
    for (const t of [s, s.partner]) {
      if (!t) continue;
      t.outlineVisible = visible;
      if (t.ready) t.post({ type: 'outline', visible });
    }
    void this.context.globalState.update(OUTLINE_KEY, visible);
  }

  /** The cursor of the MD Master editor for `uri`, if that editor is the active tab. */
  async activeSelection(uri: vscode.Uri): Promise<vscode.Selection | undefined> {
    for (const s of this.sessions) {
      if (s.panel.active && s.ready && s.document.uri.toString() === uri.toString()) {
        return s.requestSelection?.();
      }
    }
    return undefined;
  }

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

  // ------------------------------------------------------------------ export

  /** The MD Master editor a command is for: the focused one, else a visible one showing `uri`. */
  private currentSession(uri?: vscode.Uri): Session | undefined {
    const ready = [...this.sessions].filter((s) => s.ready);
    const matches = (s: Session) => !uri || s.document.uri.toString() === uri.toString();
    return (
      ready.find((s) => s.panel.active && matches(s)) ??
      (uri ? ready.find((s) => s.panel.visible && matches(s)) : undefined) ??
      ready.find((s) => s.panel.active)
    );
  }

  async export(uri?: vscode.Uri) {
    const session = this.currentSession(uri);
    if (!session) {
      vscode.window.showWarningMessage('MD Master: open a Markdown file in MD Master to export it.');
      return;
    }
    const isDiff = !!(session.partner?.ready && session.role);

    const formats: (vscode.QuickPickItem & { id: 'html' | 'md' })[] = [
      { label: '$(file-code) HTML', description: 'A web page that looks like the editor', id: 'html' },
    ];
    if (!isDiff) {
      formats.push({
        label: '$(markdown) Raw Markdown',
        description: 'A .md file without MD Master-only syntax',
        detail: 'Strips the hidden comments that store text colors and highlights, leaving plain markdown.',
        id: 'md',
      });
    }
    const format = await vscode.window.showQuickPick(formats, {
      title: isDiff ? 'Export Diff' : 'Export',
      placeHolder: 'Choose a format',
    });
    if (!format) return;
    if (format.id === 'md') return this.exportMarkdown(session);

    const currentTheme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    const themes: (vscode.QuickPickItem & { id: ExportTheme })[] = [
      { label: '$(color-mode) Current theme', description: currentTheme, id: 'current' },
      { label: '$(circle-filled) Dark+ (default dark)', id: 'dark' },
      { label: '$(circle-outline) Light+ (default light)', id: 'light' },
    ];
    const theme = await vscode.window.showQuickPick(themes, {
      title: 'Export to HTML: Theme',
      placeHolder: 'Choose the colours for the exported page',
    });
    if (!theme) return;

    const outlineOption: vscode.QuickPickItem = {
      label: 'Include outline sidebar',
      description: isDiff ? 'On the right, like here' : undefined,
      picked: session.outlineVisible,
    };
    // Only offered when there's something to strip
    const hasColors = [session, session.partner].some((s) => s && /<!--mm:/.test(s.document.getText()));
    const colorsOption: vscode.QuickPickItem = {
      label: 'Include text colors & highlights',
      description: 'Off: exported as plain text',
      picked: true,
    };
    const options = await vscode.window.showQuickPick(hasColors ? [outlineOption, colorsOption] : [outlineOption], {
      title: 'Export to HTML: Options',
      placeHolder: 'Check the options you want, then press Enter',
      canPickMany: true,
    });
    if (!options) return;
    const includeOutline = options.includes(outlineOption);
    const includeColors = options.includes(colorsOption);

    const name = path.basename(session.document.uri.path).replace(/\.(md|markdown)$/i, '');
    const realDir = session.imageDir.scheme === 'file' ? session.imageDir : vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileName = `${name}${isDiff ? '.diff' : ''}.html`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: realDir ? vscode.Uri.joinPath(realDir, fileName) : undefined,
      filters: { HTML: ['html', 'htm'] },
      saveLabel: 'Export',
      title: 'Export to HTML',
    });
    if (!target) return;

    const html = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'MD Master: exporting…' },
      async () => {
        const cssBytes = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
        );
        const css = Buffer.from(cssBytes).toString('utf8');
        const pane = async (s: Session): Promise<ExportPane | undefined> => {
          const snapshot = await s.requestSnapshot?.(includeOutline, includeColors);
          return snapshot && { snapshot, imageDir: s.imageDir };
        };
        if (isDiff) {
          const [orig, mod] = session.role === 'original' ? [session, session.partner!] : [session.partner!, session];
          const [a, b] = await Promise.all([pane(orig), pane(mod)]);
          if (!a || !b) return undefined;
          return buildDiffHtml(
            a,
            b,
            css,
            `${labelFor(orig.document, mod.document)} ↔ ${labelFor(mod.document, orig.document)}`,
            theme.id,
          );
        }
        const p = await pane(session);
        return p && buildHtml(p, css, path.basename(session.document.uri.path), theme.id);
      },
    );
    if (!html) {
      vscode.window.showErrorMessage('MD Master: export failed (the editor did not respond). Try again.');
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`MD Master: couldn't write ${target.fsPath} (${err})`);
      return;
    }
    const open = 'Open in Browser';
    const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer';
    const pick = await vscode.window.showInformationMessage(`Exported ${path.basename(target.path)}`, open, reveal);
    if (pick === open) await vscode.env.openExternal(target);
    else if (pick === reveal) await vscode.commands.executeCommand('revealFileInOS', target);
  }

  /** A copy of the file with MD Master-only syntax (color comments) removed. */
  private async exportMarkdown(session: Session) {
    const name = path.basename(session.document.uri.path).replace(/\.(md|markdown)$/i, '');
    const realDir = session.imageDir.scheme === 'file' ? session.imageDir : vscode.workspace.workspaceFolders?.[0]?.uri;
    const fileName = `${name}.raw.md`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: realDir ? vscode.Uri.joinPath(realDir, fileName) : undefined,
      filters: { Markdown: ['md', 'markdown'] },
      saveLabel: 'Export',
      title: 'Export to Raw Markdown',
    });
    if (!target) return;
    const text = (await session.requestText?.()) ?? session.document.getText();
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(stripColorComments(text), 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`MD Master: couldn't write ${target.fsPath} (${err})`);
      return;
    }
    const open = 'Open';
    const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer';
    const pick = await vscode.window.showInformationMessage(`Exported ${path.basename(target.path)}`, open, reveal);
    if (pick === open) await vscode.commands.executeCommand('vscode.open', target);
    else if (pick === reveal) await vscode.commands.executeCommand('revealFileInOS', target);
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
    // One outline for the pair: follow the side that shows it
    if (original.outlineVisible !== modified.outlineVisible) {
      original.outlineVisible = modified.outlineVisible;
      if (original.ready) original.post({ type: 'outline', visible: original.outlineVisible });
    }
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
      imageDir: (() => {
        const git = gitInfo(document.uri);
        return git ? vscode.Uri.joinPath(vscode.Uri.file(git.path), '..') : docDir;
      })(),
      outlineVisible: this.context.globalState.get<boolean>(OUTLINE_KEY, false),
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
    const imageBase = () => webview.asWebviewUri(session.imageDir).toString();

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

    let cursorId = 0;
    const cursorWaiters = new Map<number, (sel: vscode.Selection | undefined) => void>();
    session.requestSelection = () =>
      new Promise<vscode.Selection | undefined>((resolve) => {
        const id = ++cursorId;
        const timer = setTimeout(() => {
          cursorWaiters.delete(id);
          resolve(undefined);
        }, 1000);
        cursorWaiters.set(id, (sel) => {
          clearTimeout(timer);
          resolve(sel);
        });
        post({ type: 'cursor', id });
        // The webview flushes pending edits (an 'edit' message) before answering, so wait
        // for those to land in the document before the position is used.
      }).then(async (sel) => {
        await editQueue;
        return sel;
      });

    let snapshotId = 0;
    const snapshotWaiters = new Map<number, (s: Snapshot | undefined) => void>();
    session.requestSnapshot = (includeOutline, includeColors) =>
      new Promise<Snapshot | undefined>((resolve) => {
        const id = ++snapshotId;
        const timer = setTimeout(() => {
          snapshotWaiters.delete(id);
          resolve(undefined);
        }, 5000);
        snapshotWaiters.set(id, (snap) => {
          clearTimeout(timer);
          resolve(snap);
        });
        post({ type: 'snapshot', id, includeOutline, includeColors });
      });

    session.requestText = async () => {
      const text = await requestFlush();
      await editQueue;
      return text ?? document.getText();
    };

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
              outline: session.outlineVisible,
            });
            this.sendDiff(session);
            break;
          }
          case 'edit':
            void applyText(msg.text);
            break;
          case 'cursorAt': {
            const sel = msg.selection;
            cursorWaiters.get(msg.id)?.(
              sel ? new vscode.Selection(sel.anchor.line, sel.anchor.character, sel.head.line, sel.head.character) : undefined,
            );
            cursorWaiters.delete(msg.id);
            break;
          }
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
          case 'outlineVisible':
            this.setOutlineVisible(session, msg.visible);
            break;
          case 'snapshotTaken':
            snapshotWaiters.get(msg.id)?.(msg.snapshot);
            snapshotWaiters.delete(msg.id);
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
