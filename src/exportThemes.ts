import type { Snapshot } from '../webview/export';

/**
 * Built-in themes an HTML export can use instead of the user's current one. Each lists the
 * VS Code colour variables the exported page reads: the editor's stylesheet (with its own
 * fallbacks for anything missing) and the default styles VS Code gives every webview.
 */

export type ExportTheme = 'current' | 'dark' | 'light';

interface Preset {
  /** Body class / data-vscode-theme-kind value. */
  kind: 'vscode-dark' | 'vscode-light';
  /** data-vscode-theme-id / -name value. */
  name: string;
  /** Without the `--vscode-` prefix. */
  colors: Record<string, string>;
}

const DARK_PLUS: Preset = {
  kind: 'vscode-dark',
  name: 'Default Dark+',
  colors: {
    'editor-background': '#1e1e1e',
    'editor-foreground': '#d4d4d4',
    foreground: '#cccccc',
    descriptionForeground: 'rgba(204, 204, 204, 0.7)',
    errorForeground: '#f48771',
    focusBorder: '#007fd4',
    'widget-shadow': 'rgba(0, 0, 0, 0.36)',
    'textLink-foreground': '#3794ff',
    'textLink-activeForeground': '#3794ff',
    'textPreformat-foreground': '#d7ba7d',
    'textPreformat-background': 'rgba(255, 255, 255, 0.1)',
    'textBlockQuote-background': 'rgba(127, 127, 127, 0.1)',
    'textBlockQuote-border': 'rgba(0, 122, 204, 0.5)',
    'textCodeBlock-background': 'rgba(10, 10, 10, 0.4)',
    'gitDecoration-addedResourceForeground': '#81b88b',
    'gitDecoration-modifiedResourceForeground': '#e2c08d',
    'gitDecoration-deletedResourceForeground': '#c74e39',
    'diffEditor-insertedLineBackground': 'rgba(155, 185, 85, 0.2)',
    'diffEditor-insertedTextBackground': 'rgba(156, 204, 44, 0.2)',
    'diffEditor-removedLineBackground': 'rgba(255, 0, 0, 0.2)',
    'diffEditor-removedTextBackground': 'rgba(255, 0, 0, 0.2)',
    'editorGroup-border': '#444444',
    'editorWidget-background': '#252526',
    'editorWidget-foreground': '#cccccc',
    'editorWidget-border': '#454545',
    'input-background': '#3c3c3c',
    'input-foreground': '#cccccc',
    'input-placeholderForeground': '#a6a6a6',
    'editor-selectionBackground': '#264f78',
    'editor-findMatchBackground': '#515c6a',
    'editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
    'scrollbar-shadow': '#000000',
    'scrollbarSlider-background': 'rgba(121, 121, 121, 0.4)',
    'scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    'scrollbarSlider-activeBackground': 'rgba(191, 191, 191, 0.4)',
    'keybindingLabel-background': 'rgba(128, 128, 128, 0.17)',
    'keybindingLabel-foreground': '#cccccc',
    'keybindingLabel-border': 'rgba(51, 51, 51, 0.6)',
    'keybindingLabel-bottomBorder': 'rgba(68, 68, 68, 0.6)',
  },
};

const LIGHT_PLUS: Preset = {
  kind: 'vscode-light',
  name: 'Default Light+',
  colors: {
    'editor-background': '#ffffff',
    'editor-foreground': '#000000',
    foreground: '#616161',
    descriptionForeground: '#717171',
    errorForeground: '#a1260d',
    focusBorder: '#0090f1',
    'widget-shadow': 'rgba(0, 0, 0, 0.16)',
    'textLink-foreground': '#006ab1',
    'textLink-activeForeground': '#006ab1',
    'textPreformat-foreground': '#a31515',
    'textPreformat-background': 'rgba(0, 0, 0, 0.1)',
    'textBlockQuote-background': 'rgba(127, 127, 127, 0.1)',
    'textBlockQuote-border': 'rgba(0, 122, 204, 0.5)',
    'textCodeBlock-background': 'rgba(220, 220, 220, 0.4)',
    'gitDecoration-addedResourceForeground': '#587c0c',
    'gitDecoration-modifiedResourceForeground': '#895503',
    'gitDecoration-deletedResourceForeground': '#ad0707',
    'diffEditor-insertedLineBackground': 'rgba(155, 185, 85, 0.2)',
    'diffEditor-insertedTextBackground': 'rgba(156, 204, 44, 0.25)',
    'diffEditor-removedLineBackground': 'rgba(255, 0, 0, 0.2)',
    'diffEditor-removedTextBackground': 'rgba(255, 0, 0, 0.2)',
    'editorGroup-border': '#e7e7e7',
    'editorWidget-background': '#f3f3f3',
    'editorWidget-foreground': '#616161',
    'editorWidget-border': '#c8c8c8',
    'input-background': '#ffffff',
    'input-foreground': '#616161',
    'input-placeholderForeground': '#767676',
    'editor-selectionBackground': '#add6ff',
    'editor-findMatchBackground': '#a8ac94',
    'editor-findMatchHighlightBackground': 'rgba(234, 92, 0, 0.33)',
    'scrollbar-shadow': '#dddddd',
    'scrollbarSlider-background': 'rgba(100, 100, 100, 0.4)',
    'scrollbarSlider-hoverBackground': 'rgba(100, 100, 100, 0.7)',
    'scrollbarSlider-activeBackground': 'rgba(0, 0, 0, 0.6)',
    'keybindingLabel-background': 'rgba(221, 221, 221, 0.4)',
    'keybindingLabel-foreground': '#555555',
    'keybindingLabel-border': 'rgba(204, 204, 204, 0.4)',
    'keybindingLabel-bottomBorder': 'rgba(187, 187, 187, 0.4)',
  },
};

/** Fonts and sizes are settings, not theme colours: keep the user's. */
const KEEP = /^--vscode-(font-|editor-font-)/;

/** Swap the snapshot's theme for a built-in one. `current` leaves it untouched. */
export function applyTheme(snapshot: Snapshot, theme: ExportTheme): Snapshot {
  if (theme === 'current') return snapshot;
  const preset = theme === 'dark' ? DARK_PLUS : LIGHT_PLUS;

  const kept = snapshot.rootStyle
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      const prop = d.slice(0, d.indexOf(':')).trim();
      return d && (!prop.startsWith('--vscode-') || KEEP.test(prop));
    });
  const colors = Object.entries(preset.colors).map(([k, v]) => `--vscode-${k}: ${v}`);

  const bodyData = { ...snapshot.bodyData };
  for (const key of Object.keys(bodyData)) {
    if (key === 'data-vscode-theme-kind') bodyData[key] = preset.kind;
    else if (key === 'data-vscode-theme-id' || key === 'data-vscode-theme-name') bodyData[key] = preset.name;
  }

  return {
    ...snapshot,
    rootStyle: [...kept, ...colors].join('; ') + ';',
    bodyClasses: [preset.kind, ...snapshot.bodyClasses.filter((c) => !/^vscode-(light|dark|high-contrast)/.test(c))],
    bodyData,
  };
}
