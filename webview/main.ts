import './style.css';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Placeholder } from '@tiptap/extensions';
import { TextSelection } from '@tiptap/pm/state';
import GlobalDragHandle from 'tiptap-extension-global-drag-handle';
import { Markdown } from 'tiptap-markdown';
import { BubbleMenu } from './bubbleMenu';
import { SlashCommand, openSlash } from './slashMenu';
import { MdImage, RawHtmlBlock, RawHtmlInline, NotionKeys, TightTaskLists, setBaseUri } from './nodes';
import { ICONS } from './blocks';
import { MdText } from './escaping';
import { DiffHighlight, DiffController } from './diff';
import { diffChars } from 'diff';

interface VsCodeApi {
  postMessage(msg: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode: VsCodeApi =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : { postMessage: (m) => console.log('[postMessage]', m) };

interface Settings {
  maxWidth: number;
  fontFamily: string;
  fontSize: number;
}

let editor: Editor | null = null;
let bubble: BubbleMenu | null = null;
let diff: DiffController | null = null;
let readOnly = false;
let frontmatter = '';
let eol = '\n';
let trailingNewline = true;
/** The last full file text we either loaded or sent to the extension. */
let lastText = '';
/** True once the user actually changed something since the last load. */
let userEdited = false;
let sendTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- text <-> doc

function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: '', body: text };
  let fm = m[0];
  let body = text.slice(fm.length);
  const blank = /^(?:[ \t]*\r?\n)+/.exec(body);
  if (blank) {
    fm += blank[0];
    body = body.slice(blank[0].length);
  }
  return { fm, body };
}

function analyse(text: string) {
  eol = text.includes('\r\n') ? '\r\n' : '\n';
  trailingNewline = text.length === 0 || /\n$/.test(text);
}

function serialize(): string {
  if (!editor) return lastText;
  const md: string = (editor.storage as any).markdown.getMarkdown();
  let out = frontmatter + md.replace(/\s+$/, '');
  if (trailingNewline) out += '\n';
  out = out.replace(/\r\n/g, '\n');
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  return out;
}

function sendNow() {
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = undefined;
  if (!userEdited) return;
  const text = serialize();
  if (text === lastText) return;
  lastText = text;
  vscode.postMessage({ type: 'edit', text });
}

function scheduleSend() {
  userEdited = true;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = setTimeout(sendNow, 80);
}

// ---------------------------------------------------------------- cursor -> file position

interface SourcePos {
  line: number;
  character: number;
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Map an offset in `from` to the matching offset in `to` (two versions of similar text). */
function mapOffset(from: string, to: string, offset: number): number {
  if (from === to) return offset;
  const changes = diffChars(from, to, { timeout: 300 });
  if (!changes) return Math.min(offset, to.length);
  let a = 0;
  let b = 0;
  for (const c of changes) {
    const len = c.value.length;
    if (c.added) {
      b += len;
      continue;
    }
    if (offset <= a + len) return c.removed ? b : b + (offset - a);
    a += len;
    if (!c.removed) b += len;
  }
  return b;
}

/**
 * Where the selection's anchor/head sit in the file's text, as line/character.
 *
 * Serializing the document cut off at the cursor gives the markdown *before* the cursor
 * (plus whatever closing markup the cut adds, e.g. a trailing `**`); its common prefix with
 * the full serialization is the cursor's offset in the markdown. That offset is then mapped
 * onto the file's real text, which can differ from our serialization when the file hasn't
 * been edited here (different list markers, spacing…).
 */
function sourceSelection(): { anchor: SourcePos; head: SourcePos } | null {
  if (!editor) return null;
  sendNow(); // push pending edits first so the file matches what's on screen
  const nl = (t: string) => t.replace(/\r\n/g, '\n');
  const serializer = (editor.storage as any).markdown.serializer;
  const { doc, selection } = editor.state;
  const full: string = serializer.serialize(doc);
  const bodyLength = full.replace(/\s+$/, '').length;
  const fmLength = nl(frontmatter).length;
  const ours = nl(serialize());
  const actual = nl(lastText);

  const toSource = (pmPos: number): SourcePos => {
    const before: string = serializer.serialize(doc.cut(0, pmPos));
    const inBody = Math.min(commonPrefixLength(before, full), bodyLength);
    const offset = mapOffset(ours, actual, fmLength + inBody);
    const lineStart = offset > 0 ? actual.lastIndexOf('\n', offset - 1) + 1 : 0;
    let line = 0;
    for (let i = 0; i < lineStart; i++) if (actual.charCodeAt(i) === 10) line++;
    return { line, character: offset - lineStart };
  };
  const head = toSource(selection.head);
  const anchor = selection.anchor === selection.head ? head : toSource(selection.anchor);
  return { anchor, head };
}

// ---------------------------------------------------------------- frontmatter UI

const fmHost = document.getElementById('frontmatter')!;

function renderFrontmatter() {
  fmHost.innerHTML = '';
  if (!frontmatter) {
    fmHost.hidden = true;
    return;
  }
  fmHost.hidden = false;
  const inner = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/.exec(frontmatter);
  if (!inner) return;
  const yaml = inner[1];
  const trailing = frontmatter.slice(inner[0].length);
  const closer = inner[2];

  const details = document.createElement('details');
  details.className = 'fm';
  const summary = document.createElement('summary');
  const keys = yaml.split(/\r?\n/).map((l) => /^([A-Za-z0-9_-]+):/.exec(l)?.[1]).filter(Boolean);
  summary.innerHTML = `<span class="fm-title">Properties</span><span class="fm-keys">${keys.slice(0, 6).join(' · ')}${keys.length > 6 ? ' …' : ''}</span>`;
  const ta = document.createElement('textarea');
  ta.className = 'fm-text';
  ta.value = yaml;
  ta.spellcheck = false;
  ta.readOnly = readOnly;
  const autosize = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  ta.addEventListener('input', () => {
    frontmatter = `---\n${ta.value}\n${closer}\n${trailing}`;
    autosize();
    scheduleSend();
  });
  ta.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && !['s', 'f', 'p', 'w'].includes(e.key.toLowerCase())) e.stopPropagation();
  });
  details.addEventListener('toggle', autosize);
  details.append(summary, ta);
  fmHost.appendChild(details);
}

// ---------------------------------------------------------------- links

function slugify(s: string) {
  return s.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function openLink(href: string) {
  if (href.startsWith('#')) {
    const target = decodeURIComponent(href.slice(1));
    const headings = editor?.view.dom.querySelectorAll('h1,h2,h3,h4,h5,h6') ?? [];
    for (const h of Array.from(headings)) {
      if (slugify(h.textContent || '') === target) {
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
    return;
  }
  vscode.postMessage({ type: 'openLink', href });
}
window.addEventListener('mm-open-link', (e) => openLink((e as CustomEvent<string>).detail));

// ---------------------------------------------------------------- images

let imageReqId = 0;
const imageRequests = new Map<number, number>(); // id -> insert position

function requestImage(kind: 'pick' | 'paste', payload?: { data: string; ext: string }) {
  if (!editor) return;
  const id = ++imageReqId;
  imageRequests.set(id, editor.state.selection.from);
  if (kind === 'pick') vscode.postMessage({ type: 'pickImage', id });
  else vscode.postMessage({ type: 'pasteImage', id, ...payload });
}

function insertImage(id: number, src: string | null) {
  const pos = imageRequests.get(id);
  imageRequests.delete(id);
  if (!editor || !src) {
    editor?.commands.focus();
    return;
  }
  const at = Math.min(pos ?? editor.state.selection.from, editor.state.doc.content.size);
  editor.chain().focus().setTextSelection(at).setImage({ src }).run();
}

function handleImageFiles(files: FileList | null | undefined): boolean {
  const file = files && Array.from(files).find((f) => f.type.startsWith('image/'));
  if (!file) return false;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*/, '');
    requestImage('paste', { data, ext });
  };
  reader.readAsDataURL(file);
  return true;
}

// ---------------------------------------------------------------- block "+" button

function setupPlusButton(ed: Editor) {
  const host = ed.view.dom.parentElement!;
  const plus = document.createElement('div');
  // The "drag-handle" class makes the drag-handle plugin treat hovering this as "still inside"
  plus.className = 'block-plus drag-handle hide';
  plus.innerHTML = ICONS.plus;
  plus.title = 'Click to add a block below';
  host.appendChild(plus);

  const sync = () => {
    const handle = host.querySelector<HTMLElement>('.drag-handle:not(.block-plus)');
    if (!handle) return;
    plus.style.top = handle.style.top;
    plus.style.left = `calc(${handle.style.left} - 22px)`;
    plus.classList.toggle('hide', handle.classList.contains('hide'));
  };
  const attach = () => {
    const handle = host.querySelector<HTMLElement>('.drag-handle:not(.block-plus)');
    if (!handle) return false;
    handle.title = 'Drag to move · Click to select';
    new MutationObserver(sync).observe(handle, { attributes: true, attributeFilter: ['style', 'class'] });
    return true;
  };
  if (!attach()) {
    const mo = new MutationObserver(() => attach() && mo.disconnect());
    mo.observe(host, { childList: true });
  }

  // The drag-handle plugin hides the handles on any `mouseout` whose target isn't the editor
  // root or a `.drag-handle` itself. That fires when the cursor crosses the small gap between
  // the text and the handles, and when it moves onto the "+" icon's inner <svg>, so the
  // handles vanish before they can be clicked. Intercept those events (capture phase, so the
  // plugin's bubble listener never sees them) and hide after a short grace period instead.
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelHide = () => {
    clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  host.addEventListener('mouseover', cancelHide, true);
  host.addEventListener(
    'mouseout',
    (e) => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (to?.closest('.drag-handle')) {
        e.stopPropagation();
      } else if (!to || !host.contains(to)) {
        e.stopPropagation();
        cancelHide();
        hideTimer = setTimeout(() => {
          host.querySelector('.drag-handle:not(.block-plus)')?.classList.add('hide');
        }, 400);
      }
    },
    true,
  );

  plus.addEventListener('mousedown', (e) => e.preventDefault());
  plus.addEventListener('click', () => {
    const r = plus.getBoundingClientRect();
    const view = ed.view;
    const domRect = view.dom.getBoundingClientRect();
    const hit = view.posAtCoords({ left: domRect.left + 60, top: r.top + r.height / 2 });
    if (!hit) return;
    // Find the top-level block under the "+". `hit.inside` is the position *before* the node
    // it falls in, which for a top-level block resolves at depth 0 (between blocks) — so it
    // has to be treated as "the block starting here", not as a position inside one.
    const doc = view.state.doc;
    const p = hit.inside >= 0 ? hit.inside : hit.pos;
    const $p = doc.resolve(p);
    let blockStart: number;
    let block;
    if ($p.depth >= 1) {
      blockStart = $p.before(1);
      block = $p.node(1);
    } else if (doc.nodeAt(p)) {
      blockStart = p;
      block = doc.nodeAt(p)!;
    } else if ($p.nodeBefore) {
      block = $p.nodeBefore;
      blockStart = p - block.nodeSize;
    } else {
      return;
    }
    let tr = view.state.tr;
    if (block.type.name === 'paragraph' && block.content.size === 0) {
      tr = tr.setSelection(TextSelection.create(tr.doc, blockStart + 1));
    } else {
      const after = blockStart + block.nodeSize;
      tr = tr.insert(after, view.state.schema.nodes.paragraph.create());
      tr = tr.setSelection(TextSelection.create(tr.doc, after + 1));
    }
    view.dispatch(tr);
    openSlash(view);
  });
}

// ---------------------------------------------------------------- editor

function applySettings(s: Settings) {
  const root = document.documentElement.style;
  root.setProperty('--mm-max-width', `${s.maxWidth}px`);
  root.setProperty('--mm-font-size', `${s.fontSize}px`);
  if (s.fontFamily) root.setProperty('--mm-font', s.fontFamily);
  else root.removeProperty('--mm-font');
}

function createEditor(body: string) {
  const ed = new Editor({
    element: document.getElementById('editor')!,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          linkOnPaste: true,
          HTMLAttributes: { rel: null, target: null },
        },
        underline: false, // not representable in markdown
        text: false, // replaced by MdText (gentler escaping)
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        dropcursor: { color: 'var(--mm-accent)', width: 3 },
      }),
      MdText,
      TaskList,
      TaskItem.configure({ nested: true }),
      TightTaskLists,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      MdImage.configure({ inline: false, allowBase64: true }),
      RawHtmlBlock,
      RawHtmlInline,
      Placeholder.configure({
        includeChildren: true,
        showOnlyCurrent: true,
        placeholder: ({ node, editor: e, pos }) => {
          if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
          if (node.type.name !== 'paragraph') return '';
          const $pos = e.state.doc.resolve(pos);
          for (let d = $pos.depth; d > 0; d--) {
            const n = $pos.node(d).type.name;
            if (n === 'taskItem') return 'To-do';
            if (n === 'listItem') return 'List';
            if (n === 'blockquote') return 'Empty quote';
            if (n === 'tableCell' || n === 'tableHeader') return '';
          }
          return "Write something, or press '/' for commands…";
        },
      }),
      GlobalDragHandle.configure({ dragHandleWidth: 20, scrollTreshold: 100 }),
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: '-',
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: false,
      }),
      NotionKeys.configure({ onLink: () => bubble?.openLink() }),
      DiffHighlight,
      SlashCommand.configure({
        onPick: (e, block) => {
          if (block.id === 'image') requestImage('pick');
          else block.run(e);
        },
      }),
    ],
    content: body,
    autofocus: false,
    editorProps: {
      attributes: { spellcheck: 'true', class: 'mm-doc' },
      handleClick: (_view, _pos, event) => {
        const a = (event.target as HTMLElement).closest('a');
        if (a && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          openLink(a.getAttribute('href') || '');
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => handleImageFiles(event.clipboardData?.files),
      handleDrop: (_view, event) => {
        const files = (event as DragEvent).dataTransfer?.files;
        if (files?.length && handleImageFiles(files)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        mouseover: (_view, event) => {
          const a = (event.target as HTMLElement).closest('a');
          if (a && !a.title) a.title = `${a.getAttribute('href')}\n${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+click to open`;
          return false;
        },
      },
    },
    onUpdate: ({ transaction }) => {
      diff?.schedule();
      if (transaction.getMeta('mm-external')) return;
      scheduleSend();
    },
  });

  // Hold ⌘/Ctrl to make links look clickable
  const setModClass = (e: KeyboardEvent | MouseEvent) => document.body.classList.toggle('mod-down', e.metaKey || e.ctrlKey);
  window.addEventListener('keydown', setModClass);
  window.addEventListener('keyup', setModClass);
  window.addEventListener('blur', () => document.body.classList.remove('mod-down'));

  return ed;
}

function loadExternal(text: string) {
  if (!editor) return;
  if (text === lastText) return;
  if (sendTimer) clearTimeout(sendTimer);
  sendTimer = undefined;
  analyse(text);
  const { fm, body } = splitFrontmatter(text);
  frontmatter = fm;
  renderFrontmatter();
  const { from, to } = editor.state.selection;
  editor
    .chain()
    .command(({ tr }) => {
      tr.setMeta('addToHistory', false);
      tr.setMeta('mm-external', true);
      return true;
    })
    .setContent(body, { emitUpdate: false })
    .run();
  const size = editor.state.doc.content.size;
  try {
    editor.commands.setTextSelection({ from: Math.min(from, size), to: Math.min(to, size) });
  } catch {
    /* ignore */
  }
  lastText = text;
  userEdited = false;
  diff?.schedule();
}

// Don't let VS Code also act on keys the editor already handled (⌘B would toggle the
// sidebar, ⌘Z would double-undo, etc). Unhandled keys (⌘S, ⌘P, ⌘W…) still reach VS Code.
document.getElementById('page')!.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) e.stopPropagation();
});

// Clicking the empty space below the last block puts the cursor at the end (like Notion)
document.getElementById('page')!.addEventListener('mousedown', (e) => {
  if (!editor) return;
  const t = e.target as HTMLElement;
  if (t.id !== 'page' && t.id !== 'editor') return;
  const last = editor.view.dom.getBoundingClientRect();
  if (e.clientY > last.bottom) {
    e.preventDefault();
    editor.commands.focus('end');
  }
});

// ---------------------------------------------------------------- messages

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg?.type) {
    case 'init': {
      applySettings(msg.settings);
      setBaseUri(msg.baseUri);
      readOnly = !!msg.readOnly;
      document.body.classList.toggle('readonly', readOnly);
      analyse(msg.text);
      const { fm, body } = splitFrontmatter(msg.text);
      frontmatter = fm;
      lastText = msg.text;
      renderFrontmatter();
      if (editor) {
        loadExternal(msg.text);
        break;
      }
      editor = createEditor(body);
      bubble = new BubbleMenu(editor);
      setupPlusButton(editor);
      diff = new DiffController(editor, splitFrontmatter, () => frontmatter, (m) => vscode.postMessage(m));
      document.body.classList.add('ready');
      // Focus at the end of a brand-new empty doc so you can just start typing
      if (!body.trim() && !readOnly) editor.commands.focus('end');
      break;
    }
    case 'external':
      loadExternal(msg.text);
      break;
    case 'flush': {
      if (sendTimer) clearTimeout(sendTimer);
      sendTimer = undefined;
      let text: string | null = null;
      if (userEdited) {
        text = serialize();
        lastText = text;
      }
      vscode.postMessage({ type: 'flushed', id: msg.id, text });
      break;
    }
    case 'cursor':
      vscode.postMessage({ type: 'cursorAt', id: msg.id, selection: sourceSelection() });
      break;
    case 'imagePicked':
      insertImage(msg.id, msg.src);
      break;
    case 'settings':
      applySettings(msg.settings);
      break;
    case 'diff':
      diff?.enable(msg.role, msg.otherText, msg.label, msg.readOnly);
      break;
    case 'diffOther':
      diff?.setOther(msg.text);
      break;
    case 'diffEnd':
      diff?.disable();
      break;
    case 'syncScroll':
      diff?.syncScroll(msg.anchor, msg.frac, msg.atTop);
      break;
  }
});

vscode.postMessage({ type: 'ready' });
