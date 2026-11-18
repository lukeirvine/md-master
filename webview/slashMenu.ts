import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { filterBlocks, type BlockDef } from './blocks';

interface SlashState {
  active: boolean;
  from: number;
  query: string;
}

export const slashKey = new PluginKey<SlashState>('slashMenu');
const INACTIVE: SlashState = { active: false, from: 0, query: '' };

/** Open the slash menu by inserting a "/" at the cursor (used by the + button). */
export function openSlash(view: EditorView) {
  const { from, to } = view.state.selection;
  view.dispatch(view.state.tr.insertText('/', from, to).setMeta(slashKey, { open: from }));
  view.focus();
}

class SlashMenuView {
  el: HTMLDivElement;
  items: BlockDef[] = [];
  index = 0;
  lastQuery: string | null = null;

  constructor(private editor: Editor, private onPick: (b: BlockDef) => void) {
    this.el = document.createElement('div');
    this.el.className = 'mm-popover slash-menu';
    this.el.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(this.el);
  }

  update(view: EditorView) {
    const st = slashKey.getState(view.state);
    if (!st?.active) return this.hide();
    if (st.query !== this.lastQuery) {
      this.items = filterBlocks(st.query);
      this.index = 0;
      this.lastQuery = st.query;
      this.render();
    }
    if (!this.items.length) {
      // Notion closes the menu after a few non-matching characters
      if (st.query.length > 3) close(view);
      this.el.classList.remove('visible');
      return;
    }
    this.position(view, st.from);
  }

  render() {
    this.el.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'menu-heading';
    heading.textContent = this.lastQuery ? 'Results' : 'Basic blocks';
    this.el.appendChild(heading);
    this.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'menu-item' + (i === this.index ? ' selected' : '');
      row.innerHTML = `${item.icon}<span class="text"><span class="title">${item.title}</span><span class="desc">${item.description}</span></span>${
        item.shortcut ? `<span class="shortcut">${item.shortcut}</span>` : ''
      }`;
      row.addEventListener('mousemove', () => {
        if (this.index !== i) this.select(i, false);
      });
      row.addEventListener('click', () => this.onPick(item));
      this.el.appendChild(row);
    });
  }

  select(i: number, scroll = true) {
    const rows = this.el.querySelectorAll('.menu-item');
    rows[this.index]?.classList.remove('selected');
    this.index = (i + this.items.length) % this.items.length;
    const row = rows[this.index] as HTMLElement | undefined;
    row?.classList.add('selected');
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
  }

  position(view: EditorView, from: number) {
    const coords = view.coordsAtPos(from);
    this.el.classList.add('visible');
    const h = this.el.offsetHeight;
    const w = this.el.offsetWidth;
    const below = coords.bottom + 6;
    const top = below + h > window.innerHeight - 8 && coords.top - h - 6 > 8 ? coords.top - h - 6 : below;
    const left = Math.max(8, Math.min(coords.left, window.innerWidth - w - 8));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }

  hide() {
    this.el.classList.remove('visible');
    this.lastQuery = null;
  }

  destroy() {
    this.el.remove();
  }
}

function close(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(slashKey, { close: true }));
}

function canOpenAt(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return false;
  if ($from.parentOffset === 0) return true;
  const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, '￼');
  return /\s/.test(before);
}

export const SlashCommand = Extension.create<{ onPick: (editor: Editor, block: BlockDef) => void }>({
  name: 'slashCommand',
  addOptions() {
    return { onPick: () => {} };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const onPick = this.options.onPick;
    let menu: SlashMenuView | null = null;

    const pick = (block: BlockDef) => {
      const st = slashKey.getState(editor.state);
      if (!st?.active) return;
      const to = editor.state.selection.from;
      editor.view.dispatch(editor.state.tr.delete(st.from, to).setMeta(slashKey, { close: true }));
      onPick(editor, block);
    };

    return [
      new Plugin<SlashState>({
        key: slashKey,
        state: {
          init: () => INACTIVE,
          apply(tr, prev, _old, state) {
            const meta = tr.getMeta(slashKey);
            if (meta?.close) return INACTIVE;
            let next = prev;
            if (meta?.open !== undefined) next = { active: true, from: meta.open, query: '' };
            else if (!prev.active) return prev;
            else next = { ...prev, from: tr.mapping.map(prev.from) };

            const sel = state.selection;
            if (!sel.empty) return INACTIVE;
            const $head = sel.$head;
            const $start = state.doc.resolve(next.from);
            if ($head.pos <= next.from || $start.parent !== $head.parent) return INACTIVE;
            const text = state.doc.textBetween(next.from, $head.pos, '\n', '￼');
            if (!text.startsWith('/') || text.includes('\n') || text.length > 32 || /\s\s$/.test(text)) {
              return INACTIVE;
            }
            return { ...next, query: text.slice(1) };
          },
        },
        view: () => {
          menu = new SlashMenuView(editor, pick);
          return {
            update: (view) => menu!.update(view),
            destroy: () => menu?.destroy(),
          };
        },
        props: {
          handleTextInput(view, from, to, text) {
            if (text !== '/' || !canOpenAt(view.state, from)) return false;
            view.dispatch(view.state.tr.insertText('/', from, to).setMeta(slashKey, { open: from }));
            return true;
          },
          handleKeyDown(view, event) {
            const st = slashKey.getState(view.state);
            if (!st?.active || !menu || !menu.items.length) return false;
            switch (event.key) {
              case 'ArrowDown':
                menu.select(menu.index + 1);
                return true;
              case 'ArrowUp':
                menu.select(menu.index - 1);
                return true;
              case 'Enter':
              case 'Tab':
                pick(menu.items[menu.index]);
                return true;
              case 'Escape':
                close(view);
                return true;
            }
            return false;
          },
          handleDOMEvents: {
            blur: (view) => {
              if (slashKey.getState(view.state)?.active) close(view);
              return false;
            },
          },
        },
      }),
    ];
  },
});
