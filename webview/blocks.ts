import type { Editor } from '@tiptap/core';

export type BlockId =
  | 'text' | 'h1' | 'h2' | 'h3' | 'bullet' | 'numbered' | 'todo' | 'quote' | 'code'
  | 'divider' | 'table' | 'image';

export interface BlockDef {
  id: BlockId;
  title: string;
  description: string;
  icon: string; // HTML
  aliases: string[];
  /** Can this be used to "turn into" an existing block (vs. insert-only like divider)? */
  turnInto: boolean;
  shortcut?: string;
  run: (editor: Editor) => void;
}

const svg = (body: string) =>
  `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS = {
  link: svg('<path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1"/>'),
  chevron: `<svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4 4-4"/></svg>`,
  check: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>`,
  trash: svg('<path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10"/>'),
  open: svg('<path d="M11 4h5v5M16 4l-7 7M14 12v4H4V6h4"/>'),
  plus: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 4v12M4 10h12"/></svg>`,
  image: svg('<rect x="3" y="4" width="14" height="12" rx="2"/><circle cx="7.5" cy="8.5" r="1.5"/><path d="M17 13l-4-4-7 7"/>'),
  table: svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M3 12h14M8 4v12M13 4v12"/>'),
};

const tile = (inner: string, cls = '') => `<span class="tile ${cls}">${inner}</span>`;

export const BLOCKS: BlockDef[] = [
  {
    id: 'text', title: 'Text', description: 'Just start writing with plain text.',
    icon: tile('Aa', 'serif'), aliases: ['paragraph', 'plain', 'p'], turnInto: true, shortcut: '⌘⌥0',
    run: (e) => e.chain().focus().clearNodes().setParagraph().run(),
  },
  {
    id: 'h1', title: 'Heading 1', description: 'Big section heading.',
    icon: tile('H<sub>1</sub>'), aliases: ['title', 'heading', 'h1', '#'], turnInto: true, shortcut: '#',
    run: (e) => e.chain().focus().clearNodes().setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2', title: 'Heading 2', description: 'Medium section heading.',
    icon: tile('H<sub>2</sub>'), aliases: ['subtitle', 'heading', 'h2', '##'], turnInto: true, shortcut: '##',
    run: (e) => e.chain().focus().clearNodes().setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3', title: 'Heading 3', description: 'Small section heading.',
    icon: tile('H<sub>3</sub>'), aliases: ['heading', 'h3', '###'], turnInto: true, shortcut: '###',
    run: (e) => e.chain().focus().clearNodes().setHeading({ level: 3 }).run(),
  },
  {
    id: 'bullet', title: 'Bulleted list', description: 'Create a simple bulleted list.',
    icon: tile('<span class="dot">•</span>'), aliases: ['bullet', 'unordered', 'ul', 'list', '-'], turnInto: true, shortcut: '-',
    run: (e) => {
      if (e.isActive('bulletList')) return;
      e.chain().focus().clearNodes().toggleBulletList().run();
    },
  },
  {
    id: 'numbered', title: 'Numbered list', description: 'Create a list with numbering.',
    icon: tile('1.'), aliases: ['ordered', 'ol', 'numbers', 'list', '1.'], turnInto: true, shortcut: '1.',
    run: (e) => {
      if (e.isActive('orderedList')) return;
      e.chain().focus().clearNodes().toggleOrderedList().run();
    },
  },
  {
    id: 'todo', title: 'To-do list', description: 'Track tasks with a to-do list.',
    icon: tile('<span class="box"></span>'), aliases: ['todo', 'task', 'checkbox', 'check', '[]'], turnInto: true, shortcut: '[]',
    run: (e) => {
      if (e.isActive('taskList')) return;
      e.chain().focus().clearNodes().toggleTaskList().run();
    },
  },
  {
    id: 'quote', title: 'Quote', description: 'Capture a quote.',
    icon: tile('<span class="quote-bar"></span>'), aliases: ['blockquote', 'citation', '>'], turnInto: true, shortcut: '>',
    run: (e) => {
      if (e.isActive('blockquote')) return;
      e.chain().focus().clearNodes().setBlockquote().run();
    },
  },
  {
    id: 'code', title: 'Code', description: 'Capture a code snippet.',
    icon: tile('&lt;/&gt;', 'mono'), aliases: ['codeblock', 'snippet', 'pre', '```'], turnInto: true, shortcut: '```',
    run: (e) => e.chain().focus().clearNodes().setCodeBlock().run(),
  },
  {
    id: 'divider', title: 'Divider', description: 'Visually divide blocks.',
    icon: tile('<span class="hr"></span>'), aliases: ['hr', 'rule', 'separator', 'line', '---'], turnInto: false, shortcut: '---',
    run: (e) => e.chain().focus().setHorizontalRule().run(),
  },
  {
    id: 'table', title: 'Table', description: 'Add a simple table.',
    icon: tile(ICONS.table), aliases: ['grid', 'spreadsheet'], turnInto: false,
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'image', title: 'Image', description: 'Upload or embed with a link.',
    icon: tile(ICONS.image), aliases: ['picture', 'photo', 'img', 'media'], turnInto: false,
    run: () => {
      /* wired up in main.ts (needs the extension host) */
    },
  },
];

/** Which block type is the selection currently in? */
export function currentBlockId(editor: Editor): BlockId {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    switch (node.type.name) {
      case 'taskItem': return 'todo';
      case 'listItem': {
        const parent = $from.node(d - 1);
        return parent.type.name === 'orderedList' ? 'numbered' : 'bullet';
      }
      case 'blockquote': return 'quote';
      case 'codeBlock': return 'code';
    }
  }
  const tb = $from.parent;
  if (tb.type.name === 'heading') {
    const lvl = tb.attrs.level as number;
    return lvl === 1 ? 'h1' : lvl === 2 ? 'h2' : 'h3';
  }
  return 'text';
}

export function filterBlocks(query: string): BlockDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCKS;
  const scored = BLOCKS.map((b) => {
    const title = b.title.toLowerCase();
    let score = -1;
    if (title.startsWith(q)) score = 3;
    else if (title.split(' ').some((w) => w.startsWith(q))) score = 2;
    else if (b.aliases.some((a) => a.startsWith(q))) score = 1;
    else if (title.includes(q)) score = 0;
    return { b, score };
  }).filter((x) => x.score >= 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.b);
}
