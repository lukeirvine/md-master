# MD Master

A Notion-style editor for Markdown files in VS Code. You never see markdown syntax.

## Use it

- Open any `.md` file. It opens in MD Master.
- Highlight text to get the formatting toolbar (turn into, link, bold, italic, strike, code).
- Type `/` on a new line for the block menu.
- Hover a block for the `+` (add block below) and `⋮⋮` (drag to move) handles.
- Need the raw file? Click the `<>` icon in the editor title bar, or right-click the file → **Open as Raw Markdown**.

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

Markdown shortcuts work as you type: `# `, `## `, `- `, `1. `, `[] `, `> `, ` ``` `, `---`, `**bold**`, `*italic*`, `` `code` ``.

## How it treats your files

- The file is only rewritten after you change something. Opening a file never modifies it.
- Front matter (`---` YAML at the top) is kept and editable under **Properties**.
- Raw HTML and `<!-- comments -->` are kept as-is (shown as grey blocks).
- Pasted or dropped images are saved to `./assets/` next to the file.
- On first edit, the file's markdown style gets normalized (e.g. `*` bullets become `-`).

## Develop

```sh
npm install
npm run build        # or: npm run watch
npm run install-ext  # package + install into VS Code
```

Then run **Developer: Reload Window** in VS Code.
