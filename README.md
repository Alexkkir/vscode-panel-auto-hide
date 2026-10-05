# Panel Auto Hide

Automatically hides the panel (terminal, output, problems) when you switch to an editor tab.

This fork fixes the panel flash in 0.1.4: switching files closes the panel directly,
without first opening or maximizing it. Based on
[yoshintame/vscode-panel-auto-hide](https://github.com/yoshintame/vscode-panel-auto-hide).

## The problem

If you prefer working with the panel in only two states — **fully maximized** or **completely hidden** — VS Code gets you halfway there with:

```json
"workbench.panel.opensMaximized": "always"
```

This ensures the panel always opens maximized. But there are cases where the panel still ends up minimized (half-height) instead of fully hidden:

- Opening a file from the Explorer while the panel is visible
- Clicking a file link in the terminal output
- Various other editor focus changes

In all these cases VS Code minimizes the panel to half-height instead of hiding it completely. You end up with a useless half-panel covering your code, and have to manually close it.

## The solution

This extension listens for editor focus changes and automatically **closes the panel completely** whenever you switch to a different editor tab. No more half-height panel state — it's either fullscreen or gone.

## Settings

| Setting | Default | Description |
|---|---|---|
| `panelAutoHide.enabled` | `true` | Enable or disable automatic panel hiding |

## Recommended setup

```json
"workbench.panel.opensMaximized": "always"
```

## License

MIT

## Local build

Use Node.js 20 or newer and pnpm 9 (the same major version used by CI):

```sh
pnpm install --frozen-lockfile
pnpm run package
pnpm test
pnpm run vsce:package
code --install-extension panel-auto-hide-0.1.5.vsix --force
```

Reload the VS Code window after installing. The VSIX keeps the original
`yoshintame.panel-auto-hide` extension ID, so it replaces the installed version.
The source is in `src/extension.ts`; regression tests in `test/extension.test.cjs`
check the production bundle and all intermediate panel states when switching
files. The tests use a simulated VS Code API; they do not drive the workbench UI.

For an optional real workbench test, install Playwright separately and run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
VSCODE_EXECUTABLE=/absolute/path/to/Code \
node scripts/smoke-test.cjs --old-extension=/absolute/path/to/panel-auto-hide-0.1.4
```

Omit `--old-extension` to test only the current build. The script uses separate
temporary settings, extensions, and workspace files. It clicks files in the
Explorer, records panel layout changes, and saves JSON results and screenshots
in the temporary directory printed at startup. It does not modify the normal
VS Code profile.
