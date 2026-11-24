/**
 * How text colors and highlights are stored in the markdown file. Markdown has no syntax for
 * them, so colored text is wrapped in HTML comments, which every markdown renderer hides:
 *
 *   Some <!--mm:red-->red text<!--/mm--> and a <!--mm:bg-yellow-->highlight<!--/mm-->.
 *   <!--mm:blue bg-gray--> sets both.
 *
 * No DOM or editor imports: the extension host uses this too (for the "Raw Markdown" export).
 */

export const COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type ColorName = (typeof COLORS)[number];

export interface ColorStyle {
  color: ColorName | null;
  bg: ColorName | null;
}

export const OPEN_RE = /^<!--mm:([^>]*?)-->$/;
export const CLOSE_RE = /^<!--\/mm-->$/;
/** A line that starts with one of our comments (markdown-it would otherwise take it as an HTML block). */
export const LINE_START_RE = /^<!--(?:mm:|\/mm-->)/;

export function isColor(s: unknown): s is ColorName {
  return typeof s === 'string' && (COLORS as readonly string[]).includes(s);
}

/** `red bg-yellow` → { color: 'red', bg: 'yellow' }. Unknown words are ignored. */
export function parseSpec(spec: string): ColorStyle {
  const out: ColorStyle = { color: null, bg: null };
  for (const word of spec.trim().split(/\s+/)) {
    if (word.startsWith('bg-')) {
      const c = word.slice(3);
      if (isColor(c)) out.bg = c;
    } else if (isColor(word)) {
      out.color = word;
    }
  }
  return out;
}

export function toSpec(s: Partial<ColorStyle>): string {
  return [isColor(s.color) ? s.color : '', isColor(s.bg) ? `bg-${s.bg}` : ''].filter(Boolean).join(' ');
}

/**
 * Remove every color comment, leaving the text they wrapped. Fenced code blocks and inline
 * code spans are left alone, since a comment there is literal text, not styling.
 */
export function stripColorComments(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split(/(?<=\n)/)
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      return line.replace(/(`+)[\s\S]*?\1|<!--mm:[^>]*?-->|<!--\/mm-->/g, (m) => (m.startsWith('`') ? m : ''));
    })
    .join('');
}
