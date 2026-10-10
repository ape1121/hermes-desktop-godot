# hermes-desktop-godot

A [Hermes](https://github.com/NousResearch/hermes-agent) desktop plugin: open a Godot project in the
Godot editor with one click from inside Hermes, and keep the current repo's worktrees one click away.

One file, no build step, no configuration. It adds a `godot` pane, a `godot` statusbar chip, and
three ⌘K rows — and none of them appear unless the chat you are in is actually a Godot project.

```
~/.hermes/desktop-plugins/godot-launcher/plugin.js
```

## Install

**Manually (any OS)** — the app loads plugins from disk, no restart needed:

```bash
git clone https://github.com/ape1121/hermes-desktop-godot ~/.hermes/desktop-plugins/godot-launcher
```

With a named Hermes profile, use `~/.hermes/profiles/<profile>/desktop-plugins/godot-launcher`.
Already have the folder? Just drop `plugin.js` in it — the app picks up the file within a few seconds
and hot-reloads on every later save.

**From the app** — `hermes://plugin/install?repo=ape1121/hermes-desktop-godot&enable=1` opens the
install dialog (the repo-root `plugin.js` is the entry). The desktop half of a Git install is opt-in,
so flip it on in **Settings → Plugins** if it lands disabled.

Either way, nothing else is required: no Godot binary path, no config key, no enable flag.

## Requirements

- The Hermes desktop app (the CLI/gateway alone does not load desktop plugins).
- A Godot install that owns the `.godot` document type — any official build does
  (`Godot.app` / `Godot_mono.app` register `public.godot`), wherever it lives.

## Use

| Where | Action |
| --- | --- |
| Pane row (click) | Open that project in the Godot editor |
| Pane row (kebab / right-click) | Open in Godot · Reveal in file manager · Copy path · **Ask Hermes to import…** (fresh worktrees) · Remove from list (saved rows) |
| Statusbar chip | Open the workspace project without opening the pane |
| ⌘K → *Godot: open the workspace project* | Same, from the palette |
| ⌘K → *Godot: add a project…* | Pick a folder (or a `project.godot`) to keep in the list |
| ⌘K → *Godot: rescan projects* | Re-read the workspace, worktrees and saved list |

The pane lists, in order:

1. **this workspace** — the project containing the current chat's workspace (walking up a few levels),
   then every git worktree of that repo carrying its own `project.godot`, then — when the repo root is
   not itself a project — projects one level down. The session's own worktree leads and is not listed
   twice.
2. **saved** — projects you added. One that moved or was deleted stays listed with a `missing` badge
   instead of silently disappearing.

A row with an `import` badge has no `.godot/` cache yet — Godot has never imported the project there,
so authored-scene probes fail until one `godot --headless --import` has run. *Ask Hermes to import…*
prefills the composer with that request (it appends to a draft you already have, and never sends it for
you); *Copy import command* puts the raw command on the clipboard.

## How the launch works

A row hands `project.godot` to the OS file association (`ctx.os.openExternal`), so macOS/Windows/Linux
route it to whatever app owns that document type — Godot, at any install location, with no path to
configure or guess. If the hand-off fails the plugin says so and reveals the project in the file
manager instead.

## When it shows

The chip and the pane are chrome for a Godot workspace, so they exist only while there is something to
act on. The plugin keeps a per-chat workspace rather than reading the app's single workspace path,
because that path deliberately keeps the *previous* conversation's folder after a switch until the new
workspace is confirmed:

- the **statusbar chip** appears when the focused chat's workspace is a Godot project;
- the **pane** appears for a Godot workspace, and also when you have saved projects;
- otherwise neither is registered. The app keeps a pane's slot in your layout, so it returns to the
  same place rather than being re-adopted elsewhere;
- the ⌘K rows stay available in every workspace — they are the door to *add* a project when there is
  none.

A chat's workspace comes from the app's own per-session source (`projects.tree`, read-only), from
`session.info` events, or from what the plugin already settled for that chat; a real switch hides the
chrome at once, and a chat with no workspace of its own reads as "not Godot".

## What it reads

Directory listings, each `project.godot`'s `config/name` line, `git worktree list` for the workspace
repo, the app's `projects.tree` RPC, and its own saved-project list in plugin storage
(`hermes.plugin.godot-launcher.*`). It writes nothing outside that storage.

## Development

The plugin is plain ESM, loaded uncompiled — `jsx()` calls, never JSX syntax, and only
`@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve.

```bash
# syntax, as an ES module
cp plugin.js /tmp/check.mjs && node --check /tmp/check.mjs

# the app's own admission lint (imports, eval, DOM reach, prototype patching)
python3 -c "
import sys; sys.path.insert(0, '$HOME/.hermes/hermes-agent')
from pathlib import Path
from hermes_cli.plugin_validate_desktop import desktop_surface_findings
print(desktop_surface_findings(Path('plugin.js').read_text()))"
```

Then load it through the app's real loader (the strongest pre-ship check — it runs the actual import
rewrite, blob evaluation and `register(ctx)`): add a temporary test under
`~/.hermes/hermes-agent/apps/desktop/src/contrib/` that reads this file and calls
`loadRuntimePlugin(source, 'godot-launcher')` with the blob→`data:` URL reroute the other loader tests
use, run `npx vitest run --project ui <that file>`, then delete it.

A load failure shows up in `~/.hermes/logs/desktop.log` as `[plugins] runtime load failed`. Note the
reported location is the dynamic-import call site inside the app bundle, not this file — read it as
"the plugin source did not parse" and re-save. Recovery from a failed first load is ⌘K → **Reload
desktop plugins**.

## Uninstall

Delete the plugin folder (the app drops it within a few seconds), or disable it in Settings → Plugins.

## License

MIT — see [LICENSE](LICENSE).
