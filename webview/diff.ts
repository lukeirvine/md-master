import { Extension, createDocument, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { diffArrays, diffWordsWithSpace } from 'diff';

/**
 * Rich side-by-side diff. Each pane renders its own document and highlights what differs
 * from the other pane's document: red on the original side, green on the modified side,
 * using VS Code's own diff colours.
 */

export type DiffRole = 'original' | 'modified';

interface Leaf {
  pos: number;
  node: PMNode;
  sig: string;
  text: string;
}

type Op =
  | { kind: 'equal'; a: number; b: number }
  | { kind: 'change'; a: number; b: number }
  | { kind: 'del'; a: number }
  | { kind: 'ins'; b: number };

const diffKey = new PluginKey<DecorationSet>('mmDiff');

export const DiffHighlight = Extension.create({
  name: 'mmDiff',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: diffKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const next = tr.getMeta(diffKey);
            if (next) return next as DecorationSet;
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations: (state) => diffKey.getState(state),
        },
      }),
    ];
  },
});

// ------------------------------------------------------------------ diffing

/** Every textblock / atomic block, in document order, with a signature for comparison. */
function collectLeaves(doc: PMNode): Leaf[] {
  const out: Leaf[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock || (node.isBlock && node.isAtom)) {
      const $p = doc.resolve(pos);
      const path: string[] = [];
      for (let d = 1; d <= $p.depth; d++) {
        const n = $p.node(d);
        path.push(n.type.name === 'taskItem' ? `taskItem${n.attrs.checked ? 'x' : ''}` : n.type.name);
      }
      const text = node.isTextblock ? node.textBetween(0, node.content.size, undefined, '￼') : '';
      const sig = `${path.join('>')}|${node.type.name}|${JSON.stringify(node.attrs)}|${JSON.stringify(node.content.toJSON() ?? null)}`;
      out.push({ pos, node, sig, text });
      return false;
    }
    return true;
  });
  return out;
}

function similarity(a: Leaf, b: Leaf): number {
  if (a.node.type !== b.node.type) return 0;
  if (!a.text && !b.text) return 1;
  let common = 0;
  for (const part of diffWordsWithSpace(a.text, b.text)) {
    if (!part.added && !part.removed) common += part.value.length;
  }
  return common / Math.max(a.text.length, b.text.length, 1);
}

/** Where the block lives and what it is, ignoring its content. */
function shape(l: Leaf): string {
  return l.sig.slice(0, l.sig.lastIndexOf('|'));
}

function align(A: Leaf[], B: Leaf[]): Op[] {
  const parts = diffArrays(A.map((l) => l.sig), B.map((l) => l.sig));
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (!p.added && !p.removed) {
      for (let c = 0; c < p.count!; c++) ops.push({ kind: 'equal', a: i++, b: j++ });
      continue;
    }
    // A run of removals and/or additions: pair up blocks that look like edits of each other.
    let rem = 0;
    let add = 0;
    if (p.removed) rem = p.count!;
    else add = p.count!;
    const next = parts[k + 1];
    if (next && (next.added || next.removed) && (p.removed ? next.added : next.removed)) {
      if (next.removed) rem = next.count!;
      else add = next.count!;
      k++;
    }
    let ai = i;
    let bj = j;
    const aEnd = i + rem;
    const bEnd = j + add;
    while (ai < aEnd || bj < bEnd) {
      // Same kind of block in the same place (e.g. the same table cell) -> treat as an edit
      const sameShape = ai < aEnd && bj < bEnd && shape(A[ai]) === shape(B[bj]);
      if (ai < aEnd && bj < bEnd && (sameShape || similarity(A[ai], B[bj]) >= 0.35)) {
        ops.push({ kind: 'change', a: ai++, b: bj++ });
      } else if (ai < aEnd && (aEnd - ai >= bEnd - bj || bj >= bEnd)) {
        ops.push({ kind: 'del', a: ai++ });
      } else {
        ops.push({ kind: 'ins', b: bj++ });
      }
    }
    i = aEnd;
    j = bEnd;
  }
  return ops;
}

// ------------------------------------------------------------------ controller

export class DiffController {
  role: DiffRole | null = null;
  private otherText = '';
  private ownLeaves: Leaf[] = [];
  private otherToOwn: number[] = [];
  private hunks: number[] = []; // doc positions, own side
  private timer: ReturnType<typeof setTimeout> | undefined;
  private suppressScrollUntil = 0;
  private scrollRaf = 0;
  private bar = document.getElementById('diffbar')!;
  private countEl: HTMLElement | null = null;

  constructor(
    private editor: Editor,
    private splitFrontmatter: (t: string) => { fm: string; body: string },
    private getOwnFrontmatter: () => string,
    private post: (msg: unknown) => void,
  ) {
    window.addEventListener('scroll', () => this.onScroll(), { passive: true });
  }

  get active() {
    return this.role !== null;
  }

  enable(role: DiffRole, otherText: string, label: string, readOnly: boolean) {
    this.role = role;
    this.otherText = otherText;
    document.body.classList.add('diff-mode', `diff-${role}`);
    this.renderBar(label, readOnly);
    this.recompute();
  }

  disable() {
    if (!this.role) return;
    document.body.classList.remove('diff-mode', 'diff-original', 'diff-modified');
    this.role = null;
    this.bar.hidden = true;
    this.editor.view.dispatch(this.editor.state.tr.setMeta(diffKey, DecorationSet.empty));
    document.getElementById('frontmatter')?.classList.remove('fm-diff');
  }

  setOther(text: string) {
    this.otherText = text;
    this.schedule();
  }

  schedule() {
    if (!this.role) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.recompute(), 150);
  }

  recompute() {
    if (!this.role) return;
    const editor = this.editor;
    const { fm: otherFm, body } = this.splitFrontmatter(this.otherText);
    let otherDoc: PMNode;
    try {
      const html: string = (editor.storage as any).markdown.parser.parse(body);
      otherDoc = createDocument(html, editor.schema);
    } catch (err) {
      console.error('MD Master diff: could not parse other side', err);
      return;
    }
    const ownDoc = editor.state.doc;
    const isOrig = this.role === 'original';
    const A = collectLeaves(isOrig ? ownDoc : otherDoc);
    const B = collectLeaves(isOrig ? otherDoc : ownDoc);
    const ops = align(A, B);
    const own = isOrig ? A : B;
    const kind = isOrig ? 'del' : 'ins';

    const decos: Decoration[] = [];
    const otherToOwn: number[] = [];
    const hunks: number[] = [];
    let inHunk = false;
    let pendingMarker = false; // the other side has blocks with no counterpart here

    const ownIdx = (op: Op) => (isOrig ? ('a' in op ? op.a : -1) : 'b' in op ? op.b : -1);
    const otherIdx = (op: Op) => (isOrig ? ('b' in op ? op.b : -1) : 'a' in op ? op.a : -1);

    const placeMarker = (pos: number) => {
      const k = hunks.lastIndexOf(-1);
      if (k >= 0) hunks[k] = pos;
      decos.push(
        Decoration.widget(pos, () => {
          const el = document.createElement('div');
          el.className = `mm-diff-gap mm-diff-gap-${isOrig ? 'ins' : 'del'}`;
          el.contentEditable = 'false';
          el.title = isOrig ? 'Content was added here' : 'Content was removed here';
          return el;
        }, { side: -1, key: `gap-${pos}`, ignoreSelection: true }),
      );
    };

    for (const op of ops) {
      const oi = ownIdx(op);
      const leaf = oi >= 0 ? own[oi] : null;

      if (leaf && pendingMarker) {
        placeMarker(leaf.pos);
        pendingMarker = false;
      }
      if (op.kind === 'equal') {
        otherToOwn[otherIdx(op)] = oi;
        inHunk = false;
        continue;
      }
      // Start of a run of changes -> one navigable hunk
      if (!inHunk) {
        hunks.push(leaf ? leaf.pos : -1);
        inHunk = true;
      }
      if (!leaf) {
        pendingMarker = true;
        continue;
      }
      const end = leaf.pos + leaf.node.nodeSize;
      if (op.kind === 'change') {
        otherToOwn[otherIdx(op)] = oi;
        decos.push(Decoration.node(leaf.pos, end, { class: `mm-diff-line-${kind}` }));
        if (leaf.node.isTextblock) {
          const a = A[op.a].text;
          const b = B[op.b].text;
          let offset = 0;
          for (const part of diffWordsWithSpace(a, b)) {
            const mineOnly = isOrig ? part.removed : part.added;
            const theirsOnly = isOrig ? part.added : part.removed;
            if (theirsOnly) continue;
            const len = part.value.length;
            if (mineOnly && part.value.trim()) {
              decos.push(
                Decoration.inline(leaf.pos + 1 + offset, leaf.pos + 1 + offset + len, { class: `mm-diff-word-${kind}` }),
              );
            }
            offset += len;
          }
        }
      } else {
        decos.push(Decoration.node(leaf.pos, end, { class: `mm-diff-block-${kind}` }));
      }
    }
    if (pendingMarker) placeMarker(ownDoc.content.size);

    // Marker-only hunks get the position of the marker we just placed
    this.hunks = hunks.map((p) => (p >= 0 ? p : ownDoc.content.size));
    this.ownLeaves = own;
    this.otherToOwn = otherToOwn;

    const fmChanged = otherFm.trim() !== this.getOwnFrontmatter().trim();
    document.getElementById('frontmatter')?.classList.toggle('fm-diff', fmChanged);

    let set: DecorationSet;
    try {
      set = DecorationSet.create(ownDoc, decos);
    } catch (err) {
      console.error('MD Master diff: bad decorations', err);
      set = DecorationSet.empty;
    }
    editor.view.dispatch(editor.state.tr.setMeta(diffKey, set).setMeta('addToHistory', false));
    this.updateCount(hunks.length + (fmChanged && !hunks.length ? 1 : 0));
  }

  // ---------------------------------------------------------------- bar + navigation

  private renderBar(label: string, readOnly: boolean) {
    const isOrig = this.role === 'original';
    this.bar.hidden = false;
    this.bar.innerHTML = '';
    const left = document.createElement('div');
    left.className = 'db-left';
    left.innerHTML = `<span class="db-dot ${isOrig ? 'del' : 'ins'}"></span><span class="db-label"></span>${
      readOnly ? '<span class="db-badge">Read-only</span>' : ''
    }`;
    left.querySelector('.db-label')!.textContent = label;
    const right = document.createElement('div');
    right.className = 'db-right';
    this.countEl = document.createElement('span');
    this.countEl.className = 'db-count';
    const mk = (txt: string, title: string, dir: 1 | -1) => {
      const b = document.createElement('button');
      b.className = 'db-btn';
      b.innerHTML = txt;
      b.title = title;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => this.go(dir));
      return b;
    };
    right.append(
      this.countEl,
      mk('<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5-5 5 5"/></svg>', 'Previous change', -1),
      mk('<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l5 5 5-5"/></svg>', 'Next change', 1),
    );
    this.bar.append(left, right);
  }

  private updateCount(n: number) {
    if (this.countEl) this.countEl.textContent = n === 0 ? 'No changes' : n === 1 ? '1 change' : `${n} changes`;
  }

  private barHeight() {
    return this.bar.hidden ? 0 : this.bar.offsetHeight;
  }

  private topOf(pos: number): number | null {
    const view = this.editor.view;
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (dom && dom.nodeType === 1) return dom.getBoundingClientRect().top;
    try {
      return view.coordsAtPos(Math.min(pos, view.state.doc.content.size)).top;
    } catch {
      return null;
    }
  }

  private go(dir: 1 | -1) {
    const line = this.barHeight() + window.innerHeight * 0.25;
    const tops = this.hunks.map((p) => this.topOf(p)).filter((t): t is number => t !== null);
    let target: number | undefined;
    if (dir === 1) target = tops.find((t) => t > line + 4);
    else target = [...tops].reverse().find((t) => t < line - 4);
    if (target === undefined) target = dir === 1 ? tops[0] : tops[tops.length - 1];
    if (target === undefined) return;
    window.scrollBy({ top: target - line });
  }

  // ---------------------------------------------------------------- scroll sync

  private onScroll() {
    if (!this.role || performance.now() < this.suppressScrollUntil) return;
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      const ref = this.barHeight();
      if (window.scrollY <= 0) {
        this.post({ type: 'scroll', anchor: -1, frac: 0, atTop: true });
        return;
      }
      // Binary search for the first block whose bottom is below the reference line
      const leaves = this.ownLeaves;
      let lo = 0;
      let hi = leaves.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = this.editor.view.nodeDOM(leaves[mid].pos) as HTMLElement | null;
        const r = el && el.nodeType === 1 ? el.getBoundingClientRect() : null;
        if (!r) {
          lo = mid + 1;
          continue;
        }
        if (r.bottom > ref) {
          found = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      if (found < 0) return;
      const el = this.editor.view.nodeDOM(leaves[found].pos) as HTMLElement;
      const r = el.getBoundingClientRect();
      const frac = r.height ? Math.max(0, Math.min(1, (ref - r.top) / r.height)) : 0;
      this.post({ type: 'scroll', anchor: found, frac, atTop: false });
    });
  }

  syncScroll(anchor: number, frac: number, atTop: boolean) {
    if (!this.role) return;
    this.suppressScrollUntil = performance.now() + 120;
    if (atTop || anchor < 0) {
      window.scrollTo({ top: 0 });
      return;
    }
    // Their block -> our block (nearest mapped one at or before it)
    let idx: number | undefined;
    for (let k = anchor; k >= 0 && idx === undefined; k--) idx = this.otherToOwn[k];
    if (idx === undefined) return;
    const leaf = this.ownLeaves[idx];
    if (!leaf) return;
    const el = this.editor.view.nodeDOM(leaf.pos) as HTMLElement | null;
    if (!el || el.nodeType !== 1) return;
    const r = el.getBoundingClientRect();
    window.scrollBy({ top: r.top + frac * r.height - this.barHeight() });
  }
}
