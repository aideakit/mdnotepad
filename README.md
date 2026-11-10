# MD Notepad

Live Markdown preview for Notepad++ (x64). A docked panel next to the editor renders the current document as you type.

- GitHub-style rendering ([marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify)), tables, task lists, code blocks
- [Mermaid](https://github.com/mermaid-js/mermaid) diagrams (` ```mermaid ` blocks)
- Light and dark theme, scroll sync with the editor
- Relative images (`![](img/a.png)`) are loaded from the document's folder; `#anchor` links work; http/https/mailto links open in the default browser
- Export to PDF (A4, light theme)

## Install

1. Build it (below) or take `dist\mdnotepad`.
2. Close Notepad++ and copy the whole `mdnotepad` folder to `<Notepad++>\plugins\`
   (result: `plugins\mdnotepad\mdnotepad.dll` and `plugins\mdnotepad\web\`).
3. Start Notepad++, **Plugins > MD Notepad > Show/hide preview panel** (Ctrl+Alt+Shift+M).

Requires Notepad++ x64 and the Microsoft Edge WebView2 Runtime (preinstalled on Windows 11).

## Menu

| Item | What it does |
|---|---|
| Show/hide preview panel | Opens or closes the panel; the state is remembered |
| Sync scroll | The preview follows the editor's scroll position |
| Dark theme | Dark preview |
| Export PDF... | Saves the preview as an A4 PDF |

The same toggle is available as the **mn** button at the end of the toolbar.
Settings are stored in `plugins\Config\mdnotepad.ini`.

## Build

Needs Node.js, and Visual Studio Build Tools with the C++ workload and a Windows SDK.

```
pwsh -File build.ps1            # add -VcVars "<path>\vcvars64.bat" if it is not found automatically
```

The first run installs the npm packages and downloads the `Microsoft.Web.WebView2` NuGet package (pinned version,
SHA-256 checked) into `third_party\`. The result is `dist\mdnotepad`.

Layout: `src\plugin.cpp` (plugin: docking, WebView2, scroll sync, PDF), `src\npp_api.h` (the part of the Notepad++
plugin interface that is used), `web\` (the preview page, bundled with esbuild).
Set `MDNOTEPAD_LOG=1` to write a debug log to `%TEMP%\mdnotepad.log`.

## Limits

- The document encoding is taken from Scintilla: UTF-8 or the system ANSI code page; other encodings may render wrongly.
- Relative images work for documents on local or mapped drives, not for UNC network paths.
- Scroll sync is proportional (by position in the document), not line-exact.

## License

[MIT](LICENSE). Third-party components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
