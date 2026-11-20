import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

interface Heading {
  level: number;
  text: string;
  /** Doc position just before the heading node. */
  pos: number;
}

const CLOSE_ICON = `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>`;

/** Notion-style "table of contents" sidebar listing every heading in the document. */
export class Outline {
  private root = document.createElement('aside');
  private list = document.createElement('nav');
  private headings: Heading[] = [];
  private items: HTMLElement[] = [];
  private activeIdx = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scrollRaf = 0;
  private visible = false;

  constructor(
    private editor: Editor,
    /** Called when the user closes the sidebar from inside it. */
    private onClose: () => void,
  ) {
    this.root.id = 'outline';
    this.root.setAttribute('aria-label', 'Outline');
    const header = document.createElement('div');
    header.className = 'ol-header';
    header.innerHTML = `<span class="ol-title">Outline</span>`;
    const close = document.createElement('button');
    close.className = 'ol-close';
    close.title = 'Hide outline';
    close.innerHTML = CLOSE_ICON;
    close.addEventListener('click', () => this.onClose());
    header.appendChild(close);
    this.list.className = 'ol-list';
    this.root.append(header, this.list);
    document.body.appendChild(this.root);

    // Keep focus in the editor when clicking items
    this.list.addEventListener('mousedown', (e) => e.preventDefault());
    this.list.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('.ol-item');
      if (item) this.jumpTo(Number(item.dataset.idx));
    });

    editor.on('update', () => this.schedule());
    window.addEventListener('scroll', () => this.onScroll(), { passive: true });
    window.addEventListener('resize', () => this.onScroll(), { passive: true });
    this.refresh();
  }

  setVisible(v: boolean) {
    this.visible = v;
    document.body.classList.toggle('outline-open', v);
    if (v) {
      this.refresh();
      this.scrollActiveIntoView();
    }
  }

  /** Re-read headings after edits / external reloads. */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 150);
  }

  /** The rendered heading elements, in the same order (and indices) as the outline items. */
  headingElements(): (Element | null)[] {
    this.refresh();
    const view = this.editor.view;
    return this.headings.map((h) => {
      const dom = view.nodeDOM(h.pos);
      return dom && dom.nodeType === 1 ? (dom as Element) : null;
    });
  }

  private refresh() {
    this.timer = undefined;
    const headings: Heading[] = [];
    this.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        headings.push({ level: node.attrs.level, text: node.textContent.trim(), pos });
        return false;
      }
      // Headings only live at the top level or inside blockquotes / list items; skip leaf-ish blocks
      return node.type.name !== 'codeBlock' && node.type.name !== 'table';
    });
    const same =
      headings.length === this.headings.length &&
      headings.every((h, i) => h.level === this.headings[i].level && h.text === this.headings[i].text);
    this.headings = headings;
    if (!same) this.render();
    this.updateActive();
  }

  private render() {
    this.list.innerHTML = '';
    this.items = [];
    this.activeIdx = -1;
    if (!this.headings.length) {
      const empty = document.createElement('div');
      empty.className = 'ol-empty';
      empty.textContent = 'Headings you add will show up here.';
      this.list.appendChild(empty);
      return;
    }
    const minLevel = Math.min(...this.headings.map((h) => h.level));
    this.headings.forEach((h, i) => {
      const item = document.createElement('div');
      item.className = h.level === minLevel ? 'ol-item ol-top' : 'ol-item';
      item.dataset.idx = String(i);
      item.style.setProperty('--depth', String(h.level - minLevel));
      item.setAttribute('role', 'link');
      item.textContent = h.text || 'Untitled';
      if (!h.text) item.classList.add('ol-untitled');
      item.title = h.text;
      this.list.appendChild(item);
      this.items.push(item);
    });
  }

  private jumpTo(idx: number) {
    const h = this.headings[idx];
    if (!h) return;
    const view = this.editor.view;
    const node = view.state.doc.nodeAt(h.pos);
    if (!node) return;
    // Cursor at the end of the heading text
    const end = h.pos + node.nodeSize - 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)));
    view.focus();
    const dom = view.nodeDOM(h.pos) as HTMLElement | null;
    if (dom && dom.nodeType === 1) {
      const top = dom.getBoundingClientRect().top + window.scrollY - this.topInset() - 16;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
    this.setActive(idx);
  }

  private topInset() {
    const bar = document.getElementById('diffbar');
    return bar && !bar.hidden ? bar.getBoundingClientRect().height : 0;
  }

  private onScroll() {
    if (!this.visible || this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.updateActive();
    });
  }

  /** The active heading is the last one that has scrolled past the top quarter of the view. */
  private updateActive() {
    if (!this.visible || !this.headings.length) return;
    const line = this.topInset() + Math.min(120, window.innerHeight * 0.25);
    const view = this.editor.view;
    let idx = 0;
    for (let i = 0; i < this.headings.length; i++) {
      const dom = view.nodeDOM(this.headings[i].pos) as HTMLElement | null;
      if (!dom || dom.nodeType !== 1) continue;
      if (dom.getBoundingClientRect().top <= line) idx = i;
      else break;
    }
    // At the very bottom, the last heading may never reach the line
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      const last = this.headings.length - 1;
      const dom = view.nodeDOM(this.headings[last].pos) as HTMLElement | null;
      if (dom && dom.nodeType === 1 && dom.getBoundingClientRect().top < window.innerHeight) idx = last;
    }
    this.setActive(idx);
  }

  private setActive(idx: number) {
    if (idx === this.activeIdx) return;
    this.items[this.activeIdx]?.classList.remove('active');
    this.activeIdx = idx;
    this.items[idx]?.classList.add('active');
    this.scrollActiveIntoView();
  }

  private scrollActiveIntoView() {
    const el = this.items[this.activeIdx];
    if (!el) return;
    const lr = this.list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) el.scrollIntoView({ block: 'nearest' });
  }
}
