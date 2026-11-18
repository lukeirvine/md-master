import Text from '@tiptap/extension-text';
import { MarkdownSerializerState } from 'prosemirror-markdown';

/**
 * prosemirror-markdown escapes every `*`, `_`, `[`, `~`… it sees, which litters files
 * with backslashes ("2 \* 3", "\[TODO\]"). Only escape when the character could actually
 * be read back as markdown syntax.
 */
const proto = MarkdownSerializerState.prototype as any;
proto.esc = function esc(str: string, startOfLine = false): string {
  const hasLinkish = /\]\s*[(\[:]/.test(str);
  str = str.replace(/[`*\\~\[\]_]/g, (m: string, i: number) => {
    const prev = str[i - 1];
    const next = str[i + 1];
    const spaceOrEdge = (c: string | undefined) => c === undefined || /\s/.test(c);
    switch (m) {
      case '*':
      case '_':
        // Surrounded by whitespace -> can never open/close emphasis
        if (spaceOrEdge(prev) && spaceOrEdge(next) && prev !== undefined && next !== undefined) return m;
        // Intraword underscore is literal in CommonMark
        if (m === '_' && prev && next && /\w/.test(prev) && /\w/.test(next)) return m;
        return '\\' + m;
      case '~':
        return prev === '~' || next === '~' ? '\\' + m : m;
      case '[':
      case ']':
        return hasLinkish ? '\\' + m : m;
      case '\\':
        // A backslash only escapes ASCII punctuation
        return next !== undefined && /[!-/:-@[-`{-~]/.test(next) ? '\\\\' : m;
      default:
        return '\\' + m;
    }
  });
  if (startOfLine) {
    str = str
      .replace(/^(\+[ ]|[-*>])/, '\\$&')
      .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
      .replace(/^(\s*\d+)\.\s/, '$1\\. ');
  }
  return str;
};

/** Text that only entity-escapes `<` when it would look like an HTML tag. */
export const MdText = Text.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          if (state.inAutolink) return state.text(node.text, false);
          const t = (node.text as string)
            .replace(/&(?=#?\w+;)/g, '&amp;')
            .replace(/<(?=[A-Za-z/!?])/g, '&lt;');
          state.text(t, true);
        },
        parse: {},
      },
    };
  },
});
