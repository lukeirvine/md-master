# MD Master

A Notion-style editor for Markdown files in VS Code. You never see markdown syntax.

## Use it

- Open any `.md` file. It opens in MD Master.
- Highlight text to get the formatting toolbar (turn into, link, bold, italic, strike, code).
- Type `/` on a new line for the block menu.
- Hover a block for the `+` (add block below) and `⋮⋮` (drag to move) handles.
- Click the list icon in the editor title bar (or ⌃⌘O) for an **outline** of every heading. Click one to jump
  there. The heading you're reading is highlighted. Toggling it only affects that tab; newly opened files start
  the way you last left it.
- Need the raw file? Click the `<>` icon in the editor title bar (or ⌃⌘E), or right-click the file →
  **Open as Raw Markdown**. Your cursor lands in the same spot in the raw text.
- Back from raw: click the pencil icon in the title bar of any `.md` text editor.
- ⌘+click a link to open it. Links to other files open them in VS Code, and `#heading` links jump within the page.

## Diffs

Opening a changed `.md` file from Source Control (or Timeline, or "Compare with…") shows a
side-by-side rich diff: removed content in red on the left, added content in green on the right,
using your theme's diff colours. Scrolling is synced, ↑/↓ in the top bar jump between changes.
The historical side is read-only; if both sides are real files, both stay editable.
The outline shows once, on the far right, listing the new version's headings.

This uses VS Code's proposed `customEditorDiffs` API, enabled via `~/.vscode/argv.json`:

```json
"enable-proposed-api": ["local.md-master"]
```

(Requires a full VS Code restart.) Without it, git diffs still get highlighted via a fallback,
but "Compare with…" between two files won't.

## Shortcuts

| Action | Keys |
| --- | --- |
| Bold / italic / strike / code | ⌘B / ⌘I / ⌘⇧S / ⌘E |
| Link | ⌘K |
| Heading 1/2/3, Text | ⌘⌥1 / ⌘⌥2 / ⌘⌥3 / ⌘⌥0 |
| Bulleted / numbered / to-do list | ⌘⇧8 / ⌘⇧7 / ⌘⇧9 |
| Toggle to-do checkbox | ⌘Enter |
| Open link | ⌘+click |
| Indent / outdent list item | Tab / ⇧Tab |
| Turn heading / code block back into text | Backspace at its start |
| Toggle outline sidebar | ⌃⌘O (Ctrl+Alt+O on Windows/Linux) |
| Open as raw markdown | ⌃⌘E (Ctrl+Alt+E on Windows/Linux) |

Markdown shortcuts work as you type: `# `, `## `, `- `, `1. `, `[] `, `> `, ` ``` `, `---`, `**bold**`, `*italic*`, `` `code` ``.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `mdMaster.maxWidth` | `760` | Width (px) of the writing column. |
| `mdMaster.fontFamily` | (system sans) | Font for the editor. |
| `mdMaster.fontSize` | `16` | Base font size (px). |

Bold text and links take their colours from your theme (the Explorer's "modified file" colour and the
link colour), so they match the rest of VS Code.

## How it treats your files

- The file is only rewritten after you change something. Opening a file never modifies it.
- Front matter (`---` YAML at the top) is kept and editable under **Properties**.
- Raw HTML and `<!-- comments -->` are kept as-is (shown as grey blocks).
- Pasted or dropped images are saved to `./assets/` next to the file.
- On first edit, the file's markdown style gets normalized (e.g. `*` bullets become `-`).
- Files you can't write to (e.g. an old git revision) open read-only.

## Develop

```sh
npm install
npm run build        # or: npm run watch
npm run install-ext  # package + install into VS Code
```

Then run **Developer: Reload Window** in VS Code.
