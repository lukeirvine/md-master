import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * In-page find bar, styled after VS Code's own. Replaces the built-in webview find widget,
 * which can't report how many matches there are or which one is current.
 */

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  matches: Match[];
  /** Index of the current match, or -1 when there are none. */
  index: number;
  decorations: DecorationSet;
}

type FindMeta = { query: string; from: number } | { index: number };

const findKey = new PluginKey<FindState>('mmFind');

/** Every case-insensitive occurrence of `query` within a single textblock. */
function search(doc: PMNode, query: string): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const needle = query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Text of the block, with a doc position for every character. Inline atoms (images,
    // hard breaks, raw HTML) become a placeholder so matches never span them.
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        text += child.text!;
        for (let i = 0; i < child.text!.length; i++) at.push(start + i);
      } else {
        text += '￼';
        at.push(start);
      }
    });
    const hay = text.toLowerCase();
    // toLowerCase can change length for a few characters; fall back to exact case then
    const lower = hay.length === text.length;
    const h = lower ? hay : text;
    const n = lower ? needle : query;
    for (let i = h.indexOf(n); i !== -1; i = h.indexOf(n, i + n.length)) {
      out.push({ from: at[i], to: at[i + n.length - 1] + 1 });
    }
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: Match[], index: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === index ? 'mm-find-match mm-find-current' : 'mm-find-match' }),
    ),
  );
}

/** First match at or after `pos`, wrapping to the first one. */
function indexFrom(matches: Match[], pos: number): number {
  if (!matches.length) return -1;
  const i = matches.findIndex((m) => m.from >= pos);
  return i === -1 ? 0 : i;
}

const EMPTY: FindState = { query: '', matches: [], index: -1, decorations: DecorationSet.empty };

export const FindHighlight = Extension.create({
  name: 'mmFind',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (meta && 'query' in meta) {
              const matches = search(tr.doc, meta.query);
              const index = indexFrom(matches, meta.from);
              return { query: meta.query, matches, index, decorations: decorate(tr.doc, matches, index) };
            }
            if (meta && 'index' in meta) {
              return { ...prev, index: meta.index, decorations: decorate(tr.doc, prev.matches, meta.index) };
            }
            if (!tr.docChanged || !prev.query) return prev;
            // Edited while searching: re-run, staying on (or just after) the current match
            const matches = search(tr.doc, prev.query);
            const cur = prev.matches[prev.index];
            const index = cur ? indexFrom(matches, tr.mapping.map(cur.from, -1)) : indexFrom(matches, 0);
            return { ...prev, matches, index, decorations: decorate(tr.doc, matches, index) };
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

function findState(state: EditorState): FindState {
  return findKey.getState(state) ?? EMPTY;
}

const ICON = (d: string) =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
const UP = ICON('M8 13V3M3.5 7.5L8 3l4.5 4.5');
const DOWN = ICON('M8 3v10M3.5 8.5L8 13l4.5-4.5');
const CLOSE = ICON('M4 4l8 8M12 4l-8 8');

const isMac = navigator.platform.includes('Mac');

export class FindBar {
  private root = document.createElement('div');
  private input = document.createElement('input');
  private count = document.createElement('span');
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private open = false;

  constructor(private editor: Editor) {
    this.root.id = 'findbar';
    this.root.hidden = true;
    this.root.setAttribute('role', 'search');

    this.input.type = 'text';
    this.input.className = 'fb-input';
    this.input.placeholder = 'Find';
    this.input.spellcheck = false;
    this.input.setAttribute('aria-label', 'Find');
    this.count.className = 'fb-count';
    this.count.setAttribute('aria-live', 'polite');

    const k = isMac ? { prev: '⇧Enter', next: 'Enter' } : { prev: 'Shift+Enter', next: 'Enter' };
    this.prevBtn = this.button(UP, `Previous Match (${k.prev})`, () => this.step(-1));
    this.nextBtn = this.button(DOWN, `Next Match (${k.next})`, () => this.step(1));
    const close = this.button(CLOSE, 'Close (Escape)', () => this.close());

    const field = document.createElement('div');
    field.className = 'fb-field';
    field.append(this.input, this.count);
    this.root.append(field, this.prevBtn, this.nextBtn, close);
    document.body.appendChild(this.root);

    this.input.addEventListener('input', () => this.setQuery(this.input.value));
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
      // Keep VS Code from also acting on editing keys typed here (⌘A, ⌘Z, ⌘⌫…)
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape' || (mod && !['s', 'p', 'w'].includes(e.key.toLowerCase()))) {
        e.stopPropagation();
      }
    });

    // ⌘F / Ctrl+F opens; ⌘G / F3 step through matches. Capture phase so this runs before the
    // editor, and preventDefault so the "#page" handler keeps the key away from VS Code.
    window.addEventListener(
      'keydown',
      (e) => {
        const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && !e.altKey && !e.shiftKey && key === 'f') {
          e.preventDefault();
          this.show();
        } else if (this.open && ((mod && !e.altKey && key === 'g') || e.key === 'F3')) {
          e.preventDefault();
          this.step(e.shiftKey ? -1 : 1);
        } else if (this.open && e.key === 'Escape' && this.editor.view.hasFocus()) {
          // Like VS Code: Escape in the document closes find, unless something else used it
          setTimeout(() => !e.defaultPrevented && this.close(false), 0);
        }
      },
      true,
    );

    editor.on('transaction', ({ transaction }) => {
      if (this.open && (transaction.docChanged || transaction.getMeta(findKey))) this.render();
    });
  }

  private button(icon: string, title: string, run: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'fb-btn';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    b.addEventListener('click', run);
    return b;
  }

  show() {
    const { state } = this.editor;
    const { from, to, empty } = state.selection;
    // Seed with the selected text, like VS Code, when it's a short single-line selection
    const selected = empty ? '' : state.doc.textBetween(from, to, '\n');
    const seed = selected && !selected.includes('\n') && selected.length <= 200 ? selected : '';
    if (seed) this.input.value = seed;

    const wasOpen = this.open;
    this.open = true;
    this.root.hidden = false;
    document.body.classList.add('find-open');
    this.input.focus();
    this.input.select();
    if (seed || !wasOpen) this.setQuery(this.input.value);
  }

  /** Hide the bar. With `refocus`, put the cursor on the current match, like VS Code. */
  close(refocus = true) {
    if (!this.open) return;
    const view = this.editor.view;
    const { matches, index } = findState(view.state);
    const cur = matches[index];
    this.open = false;
    this.root.hidden = true;
    document.body.classList.remove('find-open');
    let tr = view.state.tr.setMeta(findKey, { query: '', from: 0 } satisfies FindMeta);
    if (refocus && cur) tr = tr.setSelection(TextSelection.create(tr.doc, cur.from, cur.to));
    view.dispatch(tr);
    if (refocus) view.focus();
  }

  private setQuery(query: string) {
    const view = this.editor.view;
    view.dispatch(view.state.tr.setMeta(findKey, { query, from: view.state.selection.from } satisfies FindMeta));
    this.reveal();
  }

  private step(dir: 1 | -1) {
    const view = this.editor.view;
    const { matches, index } = findState(view.state);
    if (!matches.length) return;
    const next = (index + dir + matches.length) % matches.length;
    view.dispatch(view.state.tr.setMeta(findKey, { index: next } satisfies FindMeta));
    this.reveal();
  }

  private render() {
    const { query, matches, index } = findState(this.editor.state);
    const none = !matches.length;
    this.count.textContent = none ? 'No results' : `${index + 1} of ${matches.length}`;
    this.root.classList.toggle('fb-none', none && !!query);
    this.prevBtn.disabled = none;
    this.nextBtn.disabled = none;
  }

  /** Scroll the current match into view (centred) if it's off screen or under the bars. */
  private reveal() {
    const view = this.editor.view;
    const { matches, index } = findState(view.state);
    const cur = matches[index];
    if (!cur) return;
    let rect: { top: number; bottom: number };
    try {
      const a = view.coordsAtPos(cur.from, 1);
      const b = view.coordsAtPos(cur.to, -1);
      rect = { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
    } catch {
      return;
    }
    const diffbar = document.getElementById('diffbar');
    const topInset = (diffbar && !diffbar.hidden ? diffbar.getBoundingClientRect().height : 0) + 44;
    if (rect.top >= topInset && rect.bottom <= window.innerHeight - 16) return;
    const target = window.scrollY + (rect.top + rect.bottom) / 2 - (window.innerHeight + topInset) / 2;
    window.scrollTo({ top: Math.max(0, target) });
  }
}
