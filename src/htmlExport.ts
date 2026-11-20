import * as vscode from 'vscode';
import * as path from 'path';
import type { Snapshot } from '../webview/export';
import { applyTheme, type ExportTheme } from './exportThemes';

export type { Snapshot, ExportTheme };

/**
 * Turns webview snapshots into a self-contained HTML page that looks like the editor:
 * the editor's own stylesheet, VS Code's theme variables, local images inlined, and a small
 * script for the outline and (in diffs) change navigation and scroll sync.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Styles that only make sense in the exported page. */
const EXPORT_CSS = `
body.mm-export #page { cursor: auto; }
body.mm-export .ProseMirror a { cursor: pointer; }
body.mm-export .ProseMirror input[type="checkbox"] { pointer-events: none; }
body.mm-export .ProseMirror :is(h1, h2, h3, h4, h5, h6) { scroll-margin-top: 16px; }
body.mm-export.diff-mode .ProseMirror :is(h1, h2, h3, h4, h5, h6) { scroll-margin-top: 50px; }
body.mm-export .fm-text { resize: none; }
`;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

/** Replace local image paths with data: URIs so the page works wherever it's saved. */
async function inlineImages(html: string, imageDir: vscode.Uri): Promise<string> {
  const re = /(<img\b[^>]*?\ssrc=")([^"]*)(")/gi;
  const srcs = new Set<string>();
  for (const m of html.matchAll(re)) srcs.add(m[2]);
  const resolved = new Map<string, string>();
  const root = vscode.workspace.getWorkspaceFolder(imageDir)?.uri ?? imageDir;
  await Promise.all(
    Array.from(srcs).map(async (raw) => {
      const src = unescapeAttr(raw);
      if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:/i.test(src)) return;
      try {
        let file: vscode.Uri;
        if (/^file:/i.test(src)) file = vscode.Uri.parse(src);
        else {
          const p = decodeURIComponent(src.split(/[?#]/)[0]);
          file = p.startsWith('/') ? vscode.Uri.joinPath(root, p) : vscode.Uri.joinPath(imageDir, p);
        }
        const mime = MIME[path.extname(file.path).toLowerCase()];
        if (!mime) return;
        const bytes = await vscode.workspace.fs.readFile(file);
        resolved.set(raw, `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`);
      } catch {
        /* leave the path as written */
      }
    }),
  );
  return html.replace(re, (all, pre, raw, post) => (resolved.has(raw) ? pre + resolved.get(raw) + post : all));
}

// ------------------------------------------------------------------ page runtime

/**
 * Runs inside the exported page. Serialized with toString(), so it must not reference
 * anything outside itself.
 */
function paneRuntime() {
  const bar = document.getElementById('diffbar');
  const inset = () => (bar ? bar.getBoundingClientRect().height : 0);
  const onFrame = (fn: () => void) => {
    let raf = 0;
    return () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), fn()));
    };
  };

  // Outline: click to jump, highlight the heading you're reading
  const outline = document.getElementById('outline');
  if (outline) {
    const list = outline.querySelector<HTMLElement>('.ol-list')!;
    const items = Array.from(outline.querySelectorAll<HTMLElement>('.ol-item'));
    const heads = items.map((it) => document.querySelector<HTMLElement>(`[data-mm-h="${it.dataset.idx}"]`));
    let active = -1;
    const setActive = (i: number) => {
      if (i === active) return;
      items[active]?.classList.remove('active');
      active = i;
      const el = items[i];
      if (!el) return;
      el.classList.add('active');
      const lr = list.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top < lr.top || r.bottom > lr.bottom) el.scrollIntoView({ block: 'nearest' });
    };
    const update = () => {
      if (!heads.length) return;
      const line = inset() + Math.min(120, window.innerHeight * 0.25);
      let idx = 0;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (!h) continue;
        if (h.getBoundingClientRect().top <= line) idx = i;
        else break;
      }
      const last = heads[heads.length - 1];
      if (
        last &&
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2 &&
        last.getBoundingClientRect().top < window.innerHeight
      ) {
        idx = heads.length - 1;
      }
      setActive(idx);
    };
    list.addEventListener('click', (e) => {
      const it = (e.target as HTMLElement).closest<HTMLElement>('.ol-item');
      const h = it && heads[Number(it.dataset.idx)];
      if (!h) return;
      const top = h.getBoundingClientRect().top + window.scrollY - inset() - 16;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      setActive(Number(it.dataset.idx));
    });
    window.addEventListener('scroll', onFrame(update), { passive: true });
    window.addEventListener('resize', onFrame(update), { passive: true });
    update();
  }

  // Diff: previous/next change, and scroll sync with the other pane (via the parent page)
  const data = document.getElementById('mm-diff');
  if (!data) return;
  const otherToOwn: (number | null)[] = JSON.parse(data.textContent || '[]');
  const leaves: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>('[data-mm-leaf]').forEach((el) => (leaves[Number(el.dataset.mmLeaf)] = el));
  const hunks = Array.from(document.querySelectorAll<HTMLElement>('[data-mm-hunk]'));

  bar?.querySelectorAll<HTMLElement>('[data-mm-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      const dir = Number(b.dataset.mmDir);
      const line = inset() + window.innerHeight * 0.25;
      const tops = hunks.map((h) => h.getBoundingClientRect().top);
      let target = dir === 1 ? tops.find((t) => t > line + 4) : [...tops].reverse().find((t) => t < line - 4);
      if (target === undefined) target = dir === 1 ? tops[0] : tops[tops.length - 1];
      if (target !== undefined) window.scrollBy({ top: target - line });
    }),
  );

  if (window.parent === window) return;
  let suppressUntil = 0;
  window.addEventListener(
    'scroll',
    onFrame(() => {
      if (performance.now() < suppressUntil) return;
      if (window.scrollY <= 0) {
        window.parent.postMessage({ mmSync: true, anchor: -1, frac: 0, atTop: true }, '*');
        return;
      }
      const ref = inset();
      const i = leaves.findIndex((el) => el && el.getBoundingClientRect().bottom > ref);
      if (i < 0) return;
      const r = leaves[i].getBoundingClientRect();
      const frac = r.height ? Math.max(0, Math.min(1, (ref - r.top) / r.height)) : 0;
      window.parent.postMessage({ mmSync: true, anchor: i, frac, atTop: false }, '*');
    }),
    { passive: true },
  );
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || !m.mmSync) return;
    suppressUntil = performance.now() + 120;
    if (m.atTop || m.anchor < 0) return window.scrollTo({ top: 0 });
    let idx: number | null | undefined;
    for (let k = m.anchor; k >= 0 && (idx === undefined || idx === null); k--) idx = otherToOwn[k];
    const el = idx === undefined || idx === null ? undefined : leaves[idx];
    if (!el) return;
    const r = el.getBoundingClientRect();
    window.scrollBy({ top: r.top + m.frac * r.height - inset() });
  });
}

/** Parent page of a diff export: relays scroll positions between the two panes. */
function splitRuntime() {
  const frames = Array.from(document.querySelectorAll('iframe'));
  window.addEventListener('message', (e) => {
    const i = frames.findIndex((f) => f.contentWindow === e.source);
    if (i < 0 || !e.data || !e.data.mmSync) return;
    frames[1 - i]?.contentWindow?.postMessage(e.data, '*');
  });
}

// ------------------------------------------------------------------ documents

function attrs(snapshot: Snapshot, extra: string[]): string {
  const cls = [...snapshot.bodyClasses, 'ready', 'readonly', 'mm-export', ...extra].join(' ');
  const data = Object.entries(snapshot.bodyData)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
  return ` class="${escapeHtml(cls)}"${data}`;
}

function paneDocument(snapshot: Snapshot, css: string, title: string): string {
  const extra = snapshot.outline ? ['outline-open'] : [];
  const diffData = snapshot.diff
    ? `<script type="application/json" id="mm-diff">${JSON.stringify(snapshot.diff.otherToOwn)}</script>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="en" style="${escapeHtml(snapshot.rootStyle)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="MD Master">
<title>${escapeHtml(title)}</title>
<style>${snapshot.defaultStyles}</style>
<style>${css}</style>
<style>${EXPORT_CSS}</style>
</head>
<body${attrs(snapshot, extra)}>
${snapshot.diffbar}
${snapshot.page}
${snapshot.outline}
${diffData}<script>(${paneRuntime.toString()})();</script>
</body>
</html>
`;
}

export interface ExportPane {
  snapshot: Snapshot;
  imageDir: vscode.Uri;
}

async function prepare(pane: ExportPane, theme: ExportTheme): Promise<Snapshot> {
  const snapshot = applyTheme(pane.snapshot, theme);
  return { ...snapshot, page: await inlineImages(snapshot.page, pane.imageDir) };
}

export async function buildHtml(pane: ExportPane, css: string, title: string, theme: ExportTheme): Promise<string> {
  return paneDocument(await prepare(pane, theme), css, title);
}

/** Two panes side by side, like VS Code's diff editor. */
export async function buildDiffHtml(
  original: ExportPane,
  modified: ExportPane,
  css: string,
  title: string,
  theme: ExportTheme,
): Promise<string> {
  const [a, b] = await Promise.all([prepare(original, theme), prepare(modified, theme)]);
  const frame = (s: Snapshot, label: string) =>
    `<iframe title="${escapeHtml(label)}" srcdoc="${escapeHtml(paneDocument(s, css, title))}"></iframe>`;
  return `<!DOCTYPE html>
<html lang="en" style="${escapeHtml(b.rootStyle)}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="MD Master">
<title>${escapeHtml(title)}</title>
<style>
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-editor-background, #fff); }
.mm-split { display: flex; height: 100%; }
.mm-split iframe { flex: 1 1 50%; min-width: 0; height: 100%; border: 0; display: block; }
.mm-split iframe + iframe {
  border-left: 1px solid var(--vscode-diffEditor-border, var(--vscode-editorGroup-border, rgba(128, 128, 128, 0.35)));
}
</style>
</head>
<body class="${escapeHtml(b.bodyClasses.filter((c) => c.startsWith('vscode-')).join(' '))}">
<div class="mm-split">
${frame(a, 'Original')}
${frame(b, 'Modified')}
</div>
<script>(${splitRuntime.toString()})();</script>
</body>
</html>
`;
}
