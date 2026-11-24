import type { Editor } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import { BLOCKS, ICONS, currentBlockId } from './blocks';
import { COLORS, applyColor, currentColors, type ColorKind, type ColorName } from './colors';

type Mode = 'format' | 'link' | 'turnInto' | 'color';

const isMac = navigator.platform.toLowerCase().includes('mac');
const mod = isMac ? '⌘' : 'Ctrl+';

/**
 * The Notion-style floating toolbar that appears when you highlight text.
 */
export class BubbleMenu {
  el: HTMLDivElement;
  private mode: Mode = 'format';
  private mouseDown = false;
  private visible = false;
  private linkInput!: HTMLInputElement;

  constructor(private editor: Editor) {
    this.el = document.createElement('div');
    this.el.className = 'mm-popover bubble-menu';
    document.body.appendChild(this.el);

    // Keep editor focus/selection when clicking buttons (but let the link input focus)
    this.el.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('input')) return;
      e.preventDefault();
    });

    const dom = editor.view.dom;
    dom.addEventListener('mousedown', () => {
      this.mouseDown = true;
      this.hide();
    });
    window.addEventListener('mouseup', () => {
      if (!this.mouseDown) return;
      this.mouseDown = false;
      setTimeout(() => this.update(), 0);
    });
    window.addEventListener('scroll', () => this.visible && this.position(), true);
    window.addEventListener('resize', () => this.visible && this.position());

    editor.on('selectionUpdate', () => this.update());
    editor.on('transaction', () => this.visible && this.mode === 'format' && this.refreshActive());
    editor.on('blur', ({ event }) => {
      const next = (event as FocusEvent).relatedTarget as Node | null;
      if (next && this.el.contains(next)) return;
      // allow the link input to take focus
      setTimeout(() => {
        if (!this.el.contains(document.activeElement)) this.hide();
      }, 0);
    });
    editor.on('focus', () => this.update());
  }

  private shouldShow(): boolean {
    const { state, view } = this.editor;
    const { selection } = state;
    if (!this.editor.isEditable) return false;
    if (selection instanceof NodeSelection) {
      return !selection.node.isAtom && selection.node.isTextblock;
    }
    if (!(selection instanceof TextSelection) || selection.empty) return false;
    if (!state.doc.textBetween(selection.from, selection.to).trim()) return false;
    if (this.editor.isActive('codeBlock')) return false;
    if (!view.hasFocus() && !this.el.contains(document.activeElement)) return false;
    return true;
  }

  update() {
    if (this.mouseDown) return;
    if (this.mode === 'link' && this.el.contains(document.activeElement)) return;
    if (!this.shouldShow()) return this.hide();
    if (!this.visible) {
      this.mode = 'format';
      this.render();
      this.visible = true;
      this.el.classList.add('visible');
    } else if (this.mode === 'format') {
      this.refreshActive();
    }
    this.position();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.mode = 'format';
    this.el.classList.remove('visible');
  }

  /** ⌘K: jump straight into link editing. */
  openLink() {
    const { selection } = this.editor.state;
    if (selection.empty && !this.editor.isActive('link')) return;
    if (this.editor.isActive('link')) this.editor.chain().extendMarkRange('link').run();
    this.mode = 'link';
    this.visible = true;
    this.el.classList.add('visible');
    this.render();
    this.position();
  }

  private btn(html: string, title: string, onClick: () => void, cls = '') {
    const b = document.createElement('button');
    b.className = `bm-btn ${cls}`;
    b.innerHTML = html;
    b.title = title;
    b.tabIndex = -1;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  private sep() {
    const s = document.createElement('span');
    s.className = 'bm-sep';
    return s;
  }

  private render() {
    this.el.innerHTML = '';
    this.el.dataset.mode = this.mode;
    if (this.mode === 'format') this.renderFormat();
    else if (this.mode === 'link') this.renderLink();
    else if (this.mode === 'color') this.renderColor();
    else this.renderTurnInto();
  }

  private renderFormat() {
    const e = this.editor;
    const current = BLOCKS.find((b) => b.id === currentBlockId(e))!;

    const turn = this.btn(`<span class="bm-label">${current.title}</span>${ICONS.chevron}`, 'Turn into', () => {
      this.mode = 'turnInto';
      this.render();
      this.position();
    }, 'bm-turn');
    turn.dataset.role = 'turn';

    const link = this.btn(`${ICONS.link}<span class="bm-label">Link</span>`, `Link (${mod}K)`, () => this.openLink(), 'bm-link');
    link.dataset.mark = 'link';

    const marks: [string, string, string, () => void, string][] = [
      ['bold', '<b>B</b>', `Bold (${mod}B)`, () => e.chain().focus().toggleBold().run(), ''],
      ['italic', '<i>i</i>', `Italic (${mod}I)`, () => e.chain().focus().toggleItalic().run(), 'serif'],
      ['strike', '<s>S</s>', `Strikethrough (${mod}⇧S)`, () => e.chain().focus().toggleStrike().run(), ''],
      ['code', '&lt;/&gt;', `Inline code (${mod}E)`, () => e.chain().focus().toggleCode().run(), 'mono'],
    ];

    this.el.append(turn, this.sep(), link, this.sep());
    for (const [name, html, title, run, cls] of marks) {
      const b = this.btn(html, title, run, cls);
      b.dataset.mark = name;
      this.el.appendChild(b);
    }

    const color = this.btn(`<span class="bm-color-a">A</span>${ICONS.chevron}`, `Text color & highlight (${mod}⇧H repeats the last one)`, () => {
      this.mode = 'color';
      this.render();
      this.position();
    }, 'bm-color');
    color.dataset.role = 'color';
    this.el.append(this.sep(), color);

    if (e.state.selection instanceof NodeSelection) {
      this.el.append(this.sep(), this.btn(ICONS.trash, 'Delete block', () => e.chain().focus().deleteSelection().run()));
    }
    this.refreshActive();
  }

  private refreshActive() {
    const e = this.editor;
    this.el.querySelectorAll<HTMLElement>('[data-mark]').forEach((b) => {
      b.classList.toggle('active', e.isActive(b.dataset.mark!));
    });
    const label = this.el.querySelector('[data-role=turn] .bm-label');
    if (label) label.textContent = BLOCKS.find((b) => b.id === currentBlockId(e))!.title;
    const a = this.el.querySelector<HTMLElement>('[data-role=color] .bm-color-a');
    if (a) {
      const { color, bg } = currentColors(e);
      a.toggleAttribute('data-color', !!color);
      if (color) a.dataset.color = color;
      a.toggleAttribute('data-bg', !!bg);
      if (bg) a.dataset.bg = bg;
    }
  }

  private renderColor() {
    const e = this.editor;
    const current = currentColors(e);
    const panel = document.createElement('div');
    panel.className = 'bm-color-panel';
    const name = (c: ColorName | null) => (c ? c[0].toUpperCase() + c.slice(1) : 'Default');
    const sections: [ColorKind, string][] = [
      ['color', 'Text color'],
      ['bg', 'Background color'],
    ];
    for (const [kind, title] of sections) {
      const heading = document.createElement('div');
      heading.className = 'menu-heading';
      heading.textContent = title;
      const row = document.createElement('div');
      row.className = 'bm-swatches';
      for (const c of [null, ...COLORS]) {
        const attr = kind === 'color' ? 'data-color' : 'data-bg';
        const inner = `<span class="sw sw-${kind}"${c ? ` ${attr}="${c}"` : ''}>${kind === 'color' ? 'A' : ''}</span>`;
        const label = kind === 'color' ? name(c) : c ? `${name(c)} background` : 'No background';
        const b = this.btn(inner, label, () => {
          applyColor(e, kind, c);
          this.mode = 'format';
          this.render();
          this.position();
        }, 'bm-swatch');
        if (current[kind] === c) b.classList.add('current');
        row.appendChild(b);
      }
      panel.append(heading, row);
    }
    this.el.appendChild(panel);
  }

  private renderLink() {
    const e = this.editor;
    const existing = (e.getAttributes('link').href as string | undefined) ?? '';
    const wrap = document.createElement('div');
    wrap.className = 'bm-link-editor';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Paste link or type a file path…';
    input.value = existing;
    input.spellcheck = false;
    this.linkInput = input;

    const apply = () => {
      const href = input.value.trim();
      const chain = e.chain().focus().extendMarkRange('link');
      if (href) chain.setLink({ href }).run();
      else chain.unsetLink().run();
      this.mode = 'format';
      this.hide();
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        apply();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.mode = 'format';
        e.commands.focus();
        this.render();
        this.position();
      }
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!this.el.contains(document.activeElement) && !e.view.hasFocus()) this.hide();
      }, 0);
    });

    wrap.appendChild(input);
    wrap.appendChild(this.btn('Done', 'Apply link (Enter)', apply, 'bm-text-btn primary'));
    if (existing) {
      wrap.appendChild(this.btn(ICONS.open, 'Open link', () => {
        window.dispatchEvent(new CustomEvent('mm-open-link', { detail: existing }));
      }));
      wrap.appendChild(this.btn(ICONS.trash, 'Remove link', () => {
        e.chain().focus().extendMarkRange('link').unsetLink().run();
        this.hide();
      }));
    }
    this.el.appendChild(wrap);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  private renderTurnInto() {
    const e = this.editor;
    const current = currentBlockId(e);
    const list = document.createElement('div');
    list.className = 'bm-turn-list';
    const heading = document.createElement('div');
    heading.className = 'menu-heading';
    heading.textContent = 'Turn into';
    list.appendChild(heading);
    for (const b of BLOCKS.filter((b) => b.turnInto)) {
      const row = document.createElement('div');
      row.className = 'menu-item compact' + (b.id === current ? ' current' : '');
      row.innerHTML = `${b.icon}<span class="text"><span class="title">${b.title}</span></span>${
        b.id === current ? `<span class="checkmark">${ICONS.check}</span>` : ''
      }`;
      row.addEventListener('click', () => {
        b.run(e);
        this.mode = 'format';
        this.render();
        this.position();
      });
      list.appendChild(row);
    }
    this.el.appendChild(list);
  }

  private position() {
    const { view, state } = this.editor;
    const { from, to } = state.selection;
    let rect: { top: number; bottom: number; left: number; right: number };
    const domSel = window.getSelection();
    if (state.selection instanceof TextSelection && domSel && domSel.rangeCount && !domSel.isCollapsed) {
      const r = domSel.getRangeAt(0).getBoundingClientRect();
      rect = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    } else {
      const a = view.coordsAtPos(from);
      const b = view.coordsAtPos(to);
      rect = { top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
    }
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const gap = 8;
    let top = rect.top - h - gap;
    if (top < gap) top = rect.bottom + gap;
    if (this.mode === 'turnInto' && top + h > window.innerHeight - gap) top = Math.max(gap, rect.top - h - gap);
    const center = this.mode !== 'turnInto' ? (rect.left + rect.right) / 2 - w / 2 : rect.left;
    const left = Math.max(gap, Math.min(center, window.innerWidth - w - gap));
    this.el.style.top = `${top}px`;
    this.el.style.left = `${left}px`;
  }
}
