# Publishing a version

For the maintainer. Replace `1.0.1` with the version being released.

## 1. Prepare

1. Set the version in `package.json` and describe the changes in `CHANGELOG.md`.
2. Build: `powershell -ExecutionPolicy Bypass -File build.ps1` (builds the 64-bit and the 32-bit plugin)
3. Commit and push:

   ```
   git push https://github.com/aideakit/mdnotepad.git main
   ```

## 2. Create the GitHub release

The release needs the tag `v1.0.1` and exactly these four files from `dist\`:

- `MDNotepad-1.0.1.zip` (for people: both DLLs and the installer)
- `mdnotepad-1.0.1-x64-plugins-admin.zip`
- `mdnotepad-1.0.1-x86-plugins-admin.zip`
- `SHA256SUMS.txt`

On the website: **Releases > Draft a new release**, tag `v1.0.1`, attach the files, **Publish release**. Or with GitHub CLI:

```
gh release create v1.0.1 dist\MDNotepad-1.0.1.zip dist\mdnotepad-1.0.1-x64-plugins-admin.zip dist\mdnotepad-1.0.1-x86-plugins-admin.zip dist\SHA256SUMS.txt --repo aideakit/mdnotepad --title "MD Notepad 1.0.1" --notes-file CHANGELOG.md
```

Upload the files of one build and do not rebuild afterwards: every build gives the archives a different checksum.

Install methods 1, 2 and 3 of the README work as soon as the release exists. To check, close Notepad++ and run in
PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod https://raw.githubusercontent.com/aideakit/mdnotepad/main/installer/get.ps1))) -Quiet
$LASTEXITCODE
```

The result must be `0`.

## 3. Add the plugin to Plugins Admin (method 4)

This needs a pull request to the official list, and the Notepad++ maintainers decide when it is accepted.

1. Fork <https://github.com/notepad-plus-plus/nppPluginList>.
2. Add the contents of `dist\pl.x64-entry.json` to the `npp-plugins` array of `src/pl.x64.json`, and
   `dist\pl.x86-entry.json` to `src/pl.x86.json`. The entries are sorted by `display-name`. For an update, change
   `version`, `id` and `repository` of the existing entries.
3. Open a pull request. Their automatic check downloads each archive from `repository` and verifies:
   - `id` is the SHA-256 of that archive;
   - `mdnotepad.dll` is at the root of the archive;
   - the file version of the DLL equals `version` (`1.0.1` means `1.0.1.0`).
4. After it is merged and appears in a Notepad++ update, remove the note under "4. Plugins Admin in Notepad++" in `README.md`.
