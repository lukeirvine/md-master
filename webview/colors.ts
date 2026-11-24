import { Mark, type Editor } from '@tiptap/core';
import type { Mark as PMMark } from '@tiptap/pm/model';
import { CLOSE_RE, LINE_START_RE, OPEN_RE, isColor, parseSpec, toSpec, type ColorName, type ColorStyle } from './colorSyntax';

export { COLORS, type ColorName } from './colorSyntax';

export type ColorKind = 'color' | 'bg';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** markdown-it instances already taught the color syntax (parse setup runs on every parse). */
const prepared = new WeakSet<object>();

function setupMarkdownIt(md: any) {
  if (prepared.has(md)) return;
  prepared.add(md);

  // A line starting with `<!--` opens an HTML block in CommonMark, which would turn a
  // paragraph that begins with colored text into raw HTML. Let our comments through as text.
  const htmlBlock = md.block.ruler.__rules__.find((r: any) => r.name === 'html_block');
  if (htmlBlock) {
    const original = htmlBlock.fn;
    md.block.ruler.at(
      'html_block',
      (state: any, startLine: number, endLine: number, silent: boolean) => {
        const pos = state.bMarks[startLine] + state.tShift[startLine];
        if (LINE_START_RE.test(state.src.slice(pos, pos + 12))) return false;
        return original(state, startLine, endLine, silent);
      },
      { alt: htmlBlock.alt },
    );
  }

  // Swap the comment pairs for spans around each text token in between. Wrapping the leaf
  // tokens (rather than everything between the comments) keeps the HTML well nested even
  // when the comments straddle bold, links, etc.
  md.core.ruler.push('mm_colors', (state: any) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      if (!block.children.some((t: any) => t.type === 'html_inline' && OPEN_RE.test(t.content.trim()))) {
        // Drop stray closers so they don't show up as raw HTML
        block.children = block.children.filter((t: any) => !(t.type === 'html_inline' && CLOSE_RE.test(t.content.trim())));
        continue;
      }
      const stack: ColorStyle[] = [];
      const out: any[] = [];
      for (const t of block.children) {
        if (t.type === 'html_inline') {
          const open = OPEN_RE.exec(t.content.trim());
          if (open) {
            const outer = stack[stack.length - 1];
            const inner = parseSpec(open[1]);
            stack.push({ color: inner.color ?? outer?.color ?? null, bg: inner.bg ?? outer?.bg ?? null });
            continue;
          }
          if (CLOSE_RE.test(t.content.trim())) {
            stack.pop();
            continue;
          }
        }
        const style = stack[stack.length - 1];
        if (style && (style.color || style.bg) && t.type === 'text' && t.content) {
          const o = new state.Token('mm_color_open', 'span', 1);
          o.meta = style;
          const c = new state.Token('mm_color_close', 'span', -1);
          c.meta = style;
          out.push(o, t, c);
        } else {
          out.push(t);
        }
      }
      block.children = out;
    }
  });
  md.renderer.rules.mm_color_open = (tokens: any[], idx: number) => {
    const s: ColorStyle = tokens[idx].meta;
    return (s.bg ? `<span data-bg="${escapeAttr(s.bg)}">` : '') + (s.color ? `<span data-color="${escapeAttr(s.color)}">` : '');
  };
  md.renderer.rules.mm_color_close = (tokens: any[], idx: number) => {
    const s: ColorStyle = tokens[idx].meta;
    return (s.color ? '</span>' : '') + (s.bg ? '</span>' : '');
  };
}

function colorMark(name: string, kind: ColorKind) {
  const attr = kind === 'color' ? 'data-color' : 'data-bg';
  const spec = (mark: PMMark) => toSpec({ [kind]: mark.attrs.color });
  return Mark.create({
    name,

    addAttributes() {
      return {
        color: {
          default: null,
          parseHTML: (el: HTMLElement) => {
            const c = el.getAttribute(attr);
            return isColor(c) ? c : null;
          },
          renderHTML: (a: Record<string, any>) => (a.color ? { [attr]: a.color } : {}),
        },
      };
    },

    parseHTML() {
      // Not consuming: a span with both attributes gets both marks
      return [{ tag: `span[${attr}]`, consuming: false, getAttrs: (el: HTMLElement) => (isColor(el.getAttribute(attr)) ? {} : false) }];
    },

    renderHTML({ HTMLAttributes }) {
      return ['span', HTMLAttributes, 0];
    },

    addStorage() {
      return {
        markdown: {
          serialize: {
            open: (_state: unknown, mark: PMMark) => (spec(mark) ? `<!--mm:${spec(mark)}-->` : ''),
            close: (_state: unknown, mark: PMMark) => (spec(mark) ? '<!--/mm-->' : ''),
            mixable: true,
          },
          parse: kind === 'color' ? { setup: setupMarkdownIt } : {},
        },
      };
    },
  });
}

/** Notion-style text color. Separate from the background so each can be set on its own. */
export const TextColor = colorMark('mmColor', 'color').extend({
  addKeyboardShortcuts() {
    return {
      // Like Notion: re-apply the last color you picked
      'Mod-Shift-h': ({ editor }) => {
        if (!lastUsed) return false;
        applyColor(editor, lastUsed.kind, lastUsed.value);
        return true;
      },
    };
  },
});

/** Notion-style background color (highlight). */
export const TextBackground = colorMark('mmBg', 'bg');

const MARK: Record<ColorKind, string> = { color: 'mmColor', bg: 'mmBg' };

let lastUsed: { kind: ColorKind; value: ColorName | null } | null = null;

/** Set (or with `null`, clear) the text or background color of the selection. */
export function applyColor(editor: Editor, kind: ColorKind, value: ColorName | null) {
  lastUsed = { kind, value };
  const chain = editor.chain().focus();
  if (value) chain.setMark(MARK[kind], { color: value }).run();
  else chain.unsetMark(MARK[kind]).run();
}

/** The selection's current color/background. */
export function currentColors(editor: Editor): ColorStyle {
  const pick = (kind: ColorKind) => {
    const c = editor.getAttributes(MARK[kind]).color;
    return isColor(c) ? c : null;
  };
  return { color: pick('color'), bg: pick('bg') };
}
