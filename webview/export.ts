import type { Outline } from './outline';
import type { DiffController } from './diff';

/**
 * A static copy of what's on screen, for the extension to turn into an HTML file.
 * Everything editor-only (handles, menus, placeholders, find highlights) is stripped, and
 * the elements the exported page's script needs are tagged with data attributes.
 */
export interface Snapshot {
  /** The <html> element's inline style: VS Code's theme variables plus our settings. */
  rootStyle: string;
  /** Theme classes VS Code puts on <body> (vscode-dark…), plus the diff ones. */
  bodyClasses: string[];
  /** VS Code's data-vscode-* attributes on <body>. */
  bodyData: Record<string, string>;
  /** The stylesheet VS Code injects into every webview. */
  defaultStyles: string;
  page: string;
  outline: string;
  diffbar: string;
  diff: { role: 'original' | 'modified'; otherToOwn: (number | null)[] } | null;
}

function pathFrom(root: Node, el: Node): number[] | null {
  const path: number[] = [];
  let n: Node | null = el;
  while (n && n !== root) {
    const parent: Node | null = n.parentNode;
    if (!parent) return null;
    path.push(Array.prototype.indexOf.call(parent.childNodes, n));
    n = parent;
  }
  return n === root ? path.reverse() : null;
}

function follow(root: Node, path: number[]): Element | null {
  let n: Node | undefined = root;
  for (const i of path) {
    n = n?.childNodes[i];
    if (!n) return null;
  }
  return n.nodeType === 1 ? (n as Element) : null;
}

/** Tag the clone's copy of each live element (clones share structure, so paths match). */
function tag(liveRoot: Node, cloneRoot: Node, els: (Element | null)[], attr: string) {
  els.forEach((el, i) => {
    const path = el && pathFrom(liveRoot, el);
    if (path) follow(cloneRoot, path)?.setAttribute(attr, String(i));
  });
}

function slugify(s: string) {
  return s.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

const STRIP_CLASSES = [
  'ProseMirror-focused',
  'ProseMirror-selectednode',
  'ProseMirror-hideselection',
  'has-focus',
  'is-empty',
  'is-editor-empty',
  'mm-find-match',
  'mm-find-current',
];

function cleanPage(live: HTMLElement, clone: HTMLElement, includeColors: boolean) {
  clone.querySelectorAll('.drag-handle, .block-plus, .ProseMirror-gapcursor').forEach((el) => el.remove());
  clone.querySelectorAll('*').forEach((el) => {
    for (const a of ['contenteditable', 'tabindex', 'translate', 'spellcheck', 'draggable', 'data-placeholder', 'role']) {
      el.removeAttribute(a);
    }
    for (const a of Array.from(el.attributes)) if (a.name.startsWith('aria-')) el.removeAttribute(a.name);
    if (el.classList.length) {
      el.classList.remove(...STRIP_CLASSES);
      if (!el.classList.length) el.removeAttribute('class');
    }
  });

  // Live state that isn't reflected in attributes
  const liveBoxes = live.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  clone.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, i) => {
    if (liveBoxes[i]?.checked) box.setAttribute('checked', '');
    else box.removeAttribute('checked');
  });
  const liveAreas = live.querySelectorAll('textarea');
  clone.querySelectorAll('textarea').forEach((ta, i) => {
    const value = liveAreas[i]?.value ?? '';
    ta.textContent = value;
    ta.setAttribute('readonly', '');
    ta.setAttribute('rows', String(Math.max(1, value.split('\n').length)));
    ta.style.removeProperty('height');
  });

  // Text colors and highlights: unwrap them if the export shouldn't have them
  if (!includeColors) {
    clone.querySelectorAll('span[data-color], span[data-bg]').forEach((span) => span.replaceWith(...Array.from(span.childNodes)));
  }

  // Images: hand the extension the markdown path (it inlines local files)
  clone.querySelectorAll('img[data-md-src]').forEach((img) => {
    img.setAttribute('src', img.getAttribute('data-md-src')!);
  });

  // Links behave like a web page: external ones open in a new tab, #anchors work natively
  clone.querySelectorAll('a[href]').forEach((a) => {
    if (/^https?:/i.test(a.getAttribute('href')!)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
    }
  });
  const seen = new Map<string, number>();
  clone.querySelectorAll('.ProseMirror :is(h1, h2, h3, h4, h5, h6)').forEach((h) => {
    const base = slugify(h.textContent || '');
    if (!base) return;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  });
}

export function takeSnapshot(
  outline: Outline | null,
  diff: DiffController | null,
  includeOutline: boolean,
  includeColors: boolean,
): Snapshot {
  const page = document.getElementById('page')!;
  const pageClone = page.cloneNode(true) as HTMLElement;

  const headings = outline?.headingElements() ?? [];
  tag(page, pageClone, headings, 'data-mm-h');
  const info = diff?.exportInfo() ?? null;
  if (info) {
    tag(page, pageClone, info.leaves, 'data-mm-leaf');
    tag(page, pageClone, info.hunks, 'data-mm-hunk');
  }
  cleanPage(page, pageClone, includeColors);

  let outlineHtml = '';
  const ol = document.getElementById('outline');
  if (includeOutline && ol && info?.role !== 'original') {
    const c = ol.cloneNode(true) as HTMLElement;
    c.querySelector('.ol-close')?.remove();
    c.querySelectorAll('.active').forEach((el) => el.classList.remove('active'));
    outlineHtml = c.outerHTML;
  }

  let diffbarHtml = '';
  const bar = document.getElementById('diffbar');
  if (info && bar && !bar.hidden) {
    const c = bar.cloneNode(true) as HTMLElement;
    c.querySelector('.db-badge')?.remove();
    c.querySelectorAll('.db-btn').forEach((b, i) => b.setAttribute('data-mm-dir', i === 0 ? '-1' : '1'));
    diffbarHtml = c.outerHTML;
  }

  const bodyData: Record<string, string> = {};
  for (const a of Array.from(document.body.attributes)) {
    if (a.name.startsWith('data-vscode-')) bodyData[a.name] = a.value;
  }

  return {
    rootStyle: document.documentElement.getAttribute('style') ?? '',
    bodyClasses: Array.from(document.body.classList).filter((c) => c.startsWith('vscode-') || c.startsWith('diff-')),
    bodyData,
    defaultStyles: document.getElementById('_defaultStyles')?.textContent ?? '',
    page: pageClone.outerHTML,
    outline: outlineHtml,
    diffbar: diffbarHtml,
    diff: info ? { role: info.role, otherToOwn: info.otherToOwn } : null,
  };
}
