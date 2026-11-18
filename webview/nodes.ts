import { Extension, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TextSelection } from '@tiptap/pm/state';

let baseUri = '';
export function setBaseUri(uri: string) {
  baseUri = uri.endsWith('/') ? uri : uri + '/';
}

export function resolveSrc(src: string | null | undefined): string {
  if (!src) return '';
  if (/^(https?:|data:|blob:|vscode-)/i.test(src) || !baseUri) return src;
  try {
    return new URL(src.replace(/^\//, ''), baseUri).toString();
  } catch {
    return src;
  }
}

/** Image whose markdown `src` stays as written, but displays via the webview URI. */
export const MdImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-md-src') || el.getAttribute('src'),
        renderHTML: (attrs: Record<string, any>) => ({
          src: resolveSrc(attrs.src),
          'data-md-src': attrs.src,
        }),
      },
    };
  },
});

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string | null) => {
  try {
    return decodeURIComponent(s || '');
  } catch {
    return s || '';
  }
};

/**
 * Raw HTML blocks (incl. <!-- comments -->) are preserved byte-for-byte instead of
 * being silently dropped like most WYSIWYG markdown editors do.
 */
export const RawHtmlBlock = Node.create({
  name: 'rawHtmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => dec(el.getAttribute('data-html')),
        renderHTML: (a) => ({ 'data-html': enc(a.html) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-raw-html]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-raw-html': '' })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'raw-html-block';
      dom.contentEditable = 'false';
      const html = (node.attrs.html as string).trim();
      const isComment = /^<!--[\s\S]*-->$/.test(html);
      const label = document.createElement('span');
      label.className = 'raw-label';
      label.textContent = isComment ? 'Comment' : 'HTML';
      const code = document.createElement('pre');
      code.textContent = isComment ? html.replace(/^<!--\s*|\s*-->$/g, '') : html;
      dom.append(label, code);
      dom.title = 'Raw HTML is preserved as-is. Open as raw markdown to edit it.';
      return { dom };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.text((node.attrs.html as string).replace(/\s+$/, ''), false);
          state.closeBlock(node);
        },
        parse: {
          setup(md: any) {
            md.renderer.rules.html_block = (tokens: any[], idx: number) =>
              `<div data-raw-html data-html="${enc(tokens[idx].content)}"></div>`;
          },
        },
      },
    };
  },
});

export const RawHtmlInline = Node.create({
  name: 'rawHtmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      html: {
        default: '',
        parseHTML: (el) => dec(el.getAttribute('data-html')),
        renderHTML: (a) => ({ 'data-html': enc(a.html) }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-raw-inline]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-raw-inline': '' })];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('span');
      const html = node.attrs.html as string;
      if (/^<br\s*\/?>$/i.test(html.trim())) {
        dom.className = 'raw-br';
        dom.textContent = '↵';
        dom.title = 'Line break';
      } else {
        dom.className = 'raw-html-inline';
        dom.textContent = html;
        dom.title = 'Raw HTML (preserved as-is)';
      }
      dom.contentEditable = 'false';
      return { dom };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(node.attrs.html);
        },
        parse: {
          setup(md: any) {
            md.renderer.rules.html_inline = (tokens: any[], idx: number) => {
              const content: string = tokens[idx].content;
              // Task-list checkboxes are injected as inline HTML by markdown-it; let them through.
              if (content.includes('task-list-item-checkbox')) return content;
              return `<span data-raw-inline data-html="${enc(content)}"></span>`;
            };
          },
        },
      },
    };
  },
});

/** Notion-ish keyboard behaviour. */
export const NotionKeys = Extension.create<{ onLink: () => void }>({
  name: 'notionKeys',
  addOptions() {
    return { onLink: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-k': () => {
        this.options.onLink();
        return true;
      },
      // Toggle the checkbox of the current to-do
      'Mod-Enter': ({ editor }) => {
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name === 'taskItem') {
            const pos = $from.before(d);
            editor.view.dispatch(
              editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: !node.attrs.checked }),
            );
            return true;
          }
        }
        return editor.commands.toggleTaskList();
      },
      // Keep Tab inside the editor instead of moving focus away
      Tab: ({ editor }) => {
        if (editor.isActive('codeBlock')) return editor.commands.insertContent('  ');
        if (editor.can().sinkListItem('listItem')) return editor.commands.sinkListItem('listItem');
        if (editor.can().sinkListItem('taskItem')) return editor.commands.sinkListItem('taskItem');
        return true;
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.can().liftListItem('listItem')) return editor.commands.liftListItem('listItem');
        if (editor.can().liftListItem('taskItem')) return editor.commands.liftListItem('taskItem');
        return true;
      },
      // Backspace at the start of a heading/quote/code turns it back into text (like Notion)
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty || !(selection instanceof TextSelection)) return false;
        const { $from } = selection;
        if ($from.parentOffset !== 0) return false;
        if ($from.parent.type.name === 'heading' || $from.parent.type.name === 'codeBlock') {
          return editor.commands.setParagraph();
        }
        return false;
      },
    };
  },
});

/** tiptap-markdown only tracks "tight" (no blank lines between items) for bullet/ordered lists. */
export const TightTaskLists = Extension.create({
  name: 'tightTaskLists',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-tight') === 'true' || !el.querySelector('p'),
            renderHTML: (a: Record<string, any>) => ({ 'data-tight': a.tight ? 'true' : null }),
          },
        },
      },
    ];
  },
});
