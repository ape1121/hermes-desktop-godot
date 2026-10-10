/**
 * godot-launcher — one-click "open this Godot project in the Godot editor"
 * for the Hermes desktop app.
 *
 * What it adds
 *   • a pane (right zone) listing the Godot projects reachable from the current
 *     workspace: the project containing the session cwd, every git worktree of
 *     that repo that carries its own project.godot, one bounded level of nested
 *     projects, and any project you saved yourself;
 *   • click a row → that project opens in the Godot editor;
 *   • kebab / right-click → reveal in Finder, copy the path, save/remove, and —
 *     for a worktree with no `.godot` cache yet — an import prompt prefilled in
 *     the composer (a fresh worktree needs one `godot --headless --import`
 *     before authored-scene probes resolve);
 *   • a statusbar chip that opens the workspace project without opening the pane;
 *   • ⌘K rows: "Godot: open the workspace project", "Godot: add project…".
 *
 * How the launch works
 *   The row hands `project.godot` to the OS file association (Godot.app
 *   registers `public.godot`), so no Godot binary path is configured, pinned, or
 *   guessed, and any install location works — /Applications/Godot_mono.app, a
 *   second version, a Homebrew cask. Verified against Godot 4.7 mono on macOS:
 *   handing Godot the project file opens the editor on that project (it writes
 *   the project's `.godot/` import cache).
 *
 * Verified with the repo's own gates: `hermes`-side desktop-surface lint
 * (`hermes_cli.plugin_validate_desktop`), an ESM syntax check, and a
 * mocked-SDK harness that runs register() and every action handler.
 *
 * Surface notes
 *   Plain ESM, loaded uncompiled: jsx() calls, never JSX syntax. Only
 *   `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve. Layout is
 *   inline style + `var(--ui-*)` theme vars, so nothing here depends on the
 *   app's Tailwind build happening to scan this file; the row/list/pill kit is
 *   the app's own Panel components, so it looks native.
 *
 * Local data it reads: `.godot`-cache presence per project directory, the
 * `config/name` line of each project.godot, `git worktree list` for the
 * workspace repo, and its own saved-project list in plugin storage.
 */

import {
  atom,
  Button,
  Codicon,
  haptic,
  host,
  icons,
  PanelAddButton,
  PanelEmpty,
  PanelListRow,
  PanelPill,
  PanelSectionLabel,
  queryClient,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'godot-launcher'
const PROJECT_FILE = 'project.godot'
const CACHE_DIR = '.godot'
const SAVED_KEY = 'savedProjects'
const QUERY_KEY = 'discover'
const POLL_MS = 20_000
/** Directories never worth descending into while looking for nested projects. */
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'target', 'venv', '__pycache__'])
const MAX_CHILD_SCAN = 24
const MAX_WALK_UP = 4
/** How often the visibility gate re-reads the workspace (the cwd atom also
 *  fires it immediately and on every session switch). */
const GATE_POLL_MS = 5_000

/** The workspace the plugin acts on: the FOCUSED chat's cwd (resolved — see
 *  `resolvedCwd` in register) and whether it holds a Godot project. Gates the
 *  chip and the pane, and feeds the pane's discovery, so everything follows the
 *  chat the user is actually in. */
const $godotGate = atom({ cwd: '', hasProject: false })

/** Workspace cwd the backend reported for each live session, keyed by stored
 *  and runtime id. `session.info` fan-outs re-emit for every live session with
 *  its own cwd, so a chat that is not on screen still gets an entry. */
const sessionCwds = new Map()

// ---------------------------------------------------------------------------
// Desktop bridge (feature-detected)
// ---------------------------------------------------------------------------

// The curated verbs all go through `ctx.os`. Directory listing, git worktrees
// and project-file reads have no `ctx.os` door, so they use the raw desktop
// bridge — probed per call, so an older shell degrades to "nothing found"
// instead of throwing out of a render.
const bridge = () => (typeof window === 'undefined' ? undefined : window.hermesDesktop)

async function readEntries(dir) {
  const api = bridge()

  if (!api || typeof api.readDir !== 'function' || !dir) {
    return null
  }

  try {
    const result = await api.readDir(dir)

    return result && !result.error && Array.isArray(result.entries) ? result.entries : null
  } catch {
    return null
  }
}

async function readProjectName(dir) {
  const api = bridge()

  if (!api || typeof api.readFileText !== 'function') {
    return null
  }

  try {
    const result = await api.readFileText(join(dir, PROJECT_FILE))

    if (!result || result.ok === false || typeof result.text !== 'string') {
      return null
    }

    const match = result.text.match(/^\s*config\/name\s*=\s*"([^"\n]{1,80})"/m)

    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

async function gitRootOf(dir) {
  const api = bridge()

  if (!api || typeof api.gitRoot !== 'function' || !dir) {
    return null
  }

  try {
    return (await api.gitRoot(dir)) || null
  } catch {
    return null
  }
}

async function worktreesOf(repoPath) {
  const api = bridge()
  const list = api && api.git ? api.git.worktreeList : undefined

  if (typeof list !== 'function' || !repoPath) {
    return []
  }

  try {
    const trees = await list.call(api.git, repoPath)

    return Array.isArray(trees) ? trees : []
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const sepIndex = value => {
  const text = String(value || '').replace(/[\\/]+$/, '')

  return { index: Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')), text }
}

function dirname(value) {
  const { index, text } = sepIndex(value)

  if (index < 0) {
    return ''
  }

  return index === 0 ? '/' : text.slice(0, index)
}

function basename(value) {
  const { index, text } = sepIndex(value)

  return index < 0 ? text : text.slice(index + 1)
}

function join(dir, name) {
  return `${String(dir || '').replace(/[\\/]+$/, '')}/${name}`
}

function normalizeDir(value) {
  const path = String(value || '').trim()

  if (!path) {
    return ''
  }

  const trimmed = path.replace(/[\\/]+$/, '')

  return trimmed || '/'
}

/** Last two path segments — enough to tell sibling projects apart in a pane. */
function shortPath(dir) {
  const parts = String(dir || '').split(/[\\/]/).filter(Boolean)

  if (parts.length <= 2) {
    return dir
  }

  return `…/${parts.slice(-2).join('/')}`
}

const isProjectEntry = entry => Boolean(entry) && entry.name === PROJECT_FILE && !entry.isDirectory
const hasImportCache = entries => entries.some(entry => entry.name === CACHE_DIR)

/** One directory → one row, or null when it is not a Godot project. */
async function probeProject(dir, origin, extra) {
  const entries = await readEntries(dir)

  if (!entries || !entries.some(isProjectEntry)) {
    return null
  }

  return {
    dir,
    fresh: !hasImportCache(entries),
    missing: false,
    name: (await readProjectName(dir)) || basename(dir) || dir,
    origin,
    ...extra
  }
}

/** Directory of the Godot project containing `startDir`, walking up a few
 *  levels. Existence only (no name read): the visibility gate calls this every
 *  few seconds, and in the common case that is a single directory read. */
async function findProjectDir(startDir) {
  let dir = normalizeDir(startDir)

  for (let step = 0; dir && step <= MAX_WALK_UP; step += 1) {
    const entries = await readEntries(dir)

    if (entries && entries.some(isProjectEntry)) {
      return dir
    }

    const parent = dirname(dir)

    if (!parent || parent === dir) {
      return null
    }

    dir = parent
  }

  return null
}

/** The project containing the session cwd, as a row. */
async function findContainingProject(startDir) {
  const dir = await findProjectDir(startDir)

  return dir ? probeProject(dir, 'cwd') : null
}

async function discoverWorkspace(cwd) {
  const root = (await gitRootOf(cwd)) || normalizeDir(cwd)
  const containing = await findContainingProject(cwd)
  const rows = []
  const seen = new Set()

  const push = row => {
    if (row && row.dir && !seen.has(row.dir)) {
      seen.add(row.dir)
      rows.push(row)
    }
  }

  for (const tree of await worktreesOf(root)) {
    if (!tree || !tree.path) {
      continue
    }

    const dir = normalizeDir(tree.path)
    const branch = tree.branch || (tree.detached ? 'detached' : '')

    // The project the session lives in is usually one of these worktrees —
    // keep its single row and carry the branch onto it instead of listing the
    // same directory twice.
    if (containing && dir === containing.dir) {
      containing.branch = branch
      containing.isMain = Boolean(tree.isMain)

      continue
    }

    push(await probeProject(dir, 'worktree', { branch, isMain: Boolean(tree.isMain) }))
  }

  if (containing) {
    rows.unshift(containing)
  }

  // A repo whose Godot projects sit one level down (monorepo / a games folder).
  if (!containing && root) {
    const entries = (await readEntries(root)) || []
    const children = entries
      .filter(entry => entry.isDirectory && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name))
      .slice(0, MAX_CHILD_SCAN)

    for (const child of children) {
      push(await probeProject(child.path, 'nested'))
    }
  }

  return rows
}

async function savedRows(dirs) {
  const rows = []

  for (const dir of dirs) {
    const row = await probeProject(dir, 'saved')

    // A saved project that moved or was deleted stays visible and removable
    // instead of vanishing without explanation.
    rows.push(row || { dir, fresh: false, missing: true, name: basename(dir) || dir, origin: 'saved' })
  }

  return rows
}

async function discoverAll(cwd, saved) {
  try {
    const [workspace, pinned] = await Promise.all([discoverWorkspace(cwd), savedRows(saved)])

    return { pinned, workspace }
  } catch {
    return { pinned: [], workspace: [] }
  }
}

// ---------------------------------------------------------------------------
// Styling — inline style on `var(--ui-*)` so it cannot drift from the theme,
// and cannot depend on this file being part of the app's CSS build.
// ---------------------------------------------------------------------------

const S = {
  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    height: '100%',
    minHeight: 0,
    padding: '10px 8px 8px'
  },
  header: { alignItems: 'center', display: 'flex', gap: '6px', padding: '0 6px 6px' },
  headerTitle: {
    color: 'var(--ui-text-tertiary)',
    fontSize: '0.7rem',
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase'
  },
  list: {
    display: 'flex',
    flex: 1,
    flexDirection: 'column',
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain'
  },
  section: { padding: '8px 6px 2px' },
  action: { alignItems: 'center', display: 'flex', gap: '6px', justifyContent: 'center', padding: '2px 6px' },
  hint: {
    color: 'var(--ui-text-quaternary)',
    fontSize: '0.66rem',
    lineHeight: 1.5,
    padding: '8px 6px 0'
  },
  rowPath: { color: 'var(--ui-text-quaternary)', fontWeight: 400 }
}

const chipClass =
  'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: ID,
  name: 'Godot Launcher',

  register(ctx) {
    const readSaved = () => {
      try {
        const value = ctx.storage.get(SAVED_KEY, [])

        return Array.isArray(value)
          ? value.map(normalizeDir).filter(dir => dir && dir !== '/')
          : []
      } catch {
        return []
      }
    }

    const writeSaved = dirs => ctx.storage.set(SAVED_KEY, [...new Set(dirs)])

    const refresh = () => void queryClient.invalidateQueries({ queryKey: [ID, QUERY_KEY] })

    const notify = (kind, message) => host.notify({ kind, message })

    // --- actions ----------------------------------------------------------

    /** Hand the project file to the OS association → the Godot editor. */
    const openProject = async row => {
      if (!row || !row.dir) {
        return
      }

      if (row.missing) {
        notify('warning', `${row.dir} is gone — remove it from the list.`)
        await ctx.os.revealPath(row.dir)
        refresh()

        return
      }

      haptic('tap')

      const launched = await ctx.os.openExternal(join(row.dir, PROJECT_FILE))

      if (!launched) {
        notify('error', `Couldn't hand ${row.name} to the OS — revealing it in the file manager instead.`)
        await ctx.os.revealPath(row.dir)

        return
      }

      notify('info', `Opening ${row.name} in Godot`)
    }

    const copyPath = async row => {
      const copied = await ctx.os.writeClipboard(row.dir)

      notify(copied ? 'success' : 'error', copied ? 'Project path copied' : 'Clipboard unavailable')
    }

    const importCommand = dir => `godot --headless --import --path "${dir}"`

    const copyImportCommand = async row => {
      const copied = await ctx.os.writeClipboard(importCommand(row.dir))

      notify(copied ? 'info' : 'error', copied ? 'Import command copied' : 'Clipboard unavailable')
    }

    const importPrompt = row =>
      [
        `Import the fresh Godot worktree at ${row.dir}:`,
        `run \`${importCommand(row.dir)}\` with that directory as the workdir, then report the peak memory`,
        'and whether `.godot/` populated. A fresh worktree has no import cache, so authored-scene',
        'probes fail until this has run once.'
      ].join(' ')

    /** Prefill the composer with the import prompt — the user sends it. */
    const askHermesToImport = async row => {
      const prompt = importPrompt(row)

      try {
        const existing = await host.composer.getDraft(null)

        if (existing && existing.trim()) {
          await host.composer.insertText(null, `\n\n${prompt}`)
        } else {
          await host.composer.setDraft(null, prompt)
        }

        host.composer.focus(null)
        notify('info', 'Import prompt is in the composer — press ⏎ to run it')
      } catch {
        const copied = await ctx.os.writeClipboard(importCommand(row.dir))

        notify(copied ? 'info' : 'error', copied ? 'Copy command is on the clipboard' : 'Composer and clipboard are both unavailable')
      }
    }

    const addProject = async () => {
      const api = bridge()
      let dir = ''

      // Folder picker first (the gesture that matches "a Godot project"), with
      // the SDK's file picker as the fallback on an older shell.
      if (api && typeof api.selectPaths === 'function') {
        try {
          const picked = await api.selectPaths({
            directories: true,
            multiple: false,
            title: 'Choose a Godot project folder'
          })

          dir = normalizeDir(Array.isArray(picked) ? picked[0] : picked)
        } catch {
          dir = ''
        }
      }

      if (!dir) {
        const file = await ctx.os.pickOpenPath({
          filters: [{ extensions: ['godot'], name: 'Godot project' }],
          title: `Choose a ${PROJECT_FILE}`
        })

        dir = file ? dirname(file) : ''
      }

      if (!dir) {
        return
      }

      const entries = await readEntries(dir)

      if (!entries || !entries.some(isProjectEntry)) {
        notify('warning', `${dir} has no ${PROJECT_FILE}`)

        return
      }

      const saved = readSaved()

      if (!saved.includes(dir)) {
        writeSaved([...saved, dir])
      }

      refresh()
      void syncGate()
      notify('success', `Added ${basename(dir)}`)
    }

    const removeProject = row => {
      writeSaved(readSaved().filter(dir => dir !== row.dir))
      refresh()
      void syncGate()
      notify('info', `Removed ${row.name}`)
    }

    const menuItemsFor = row => {
      const items = [
        { icon: 'play', label: 'Open in Godot', onSelect: () => void openProject(row) },
        { icon: 'link-external', label: 'Reveal in file manager', onSelect: () => void ctx.os.revealPath(row.dir) },
        { icon: 'copy', label: 'Copy path', onSelect: () => void copyPath(row) }
      ]

      // Gated on the missing cache, not on where the row came from: the
      // session's own worktree is the case this exists for.
      if (row.fresh) {
        items.push(
          { icon: 'sync', label: 'Ask Hermes to import…', onSelect: () => void askHermesToImport(row) },
          { icon: 'terminal', label: 'Copy import command', onSelect: () => void copyImportCommand(row) }
        )
      }

      if (row.origin === 'saved') {
        items.push({ icon: 'trash', label: 'Remove from list', onSelect: () => removeProject(row), tone: 'danger' })
      }

      return items
    }

    /** ⌘K / chip: open the project this workspace lives in. */
    const openWorkspaceProject = async () => {
      const cwd = resolvedCwd()
      const rows = await discoverWorkspace(cwd)
      const row = rows.find(candidate => candidate.origin === 'cwd') || rows[0]

      if (!row) {
        notify('info', cwd ? `No Godot project in ${cwd}` : 'No active workspace yet')

        return
      }

      await openProject(row)
    }

    // --- UI ---------------------------------------------------------------

    const useDiscovery = () => {
      // The resolved workspace (focused chat's own cwd), not the selected
      // conversation's atom — see `resolvedCwd`.
      const { cwd } = useValue($godotGate)
      const query = useQuery({
        queryFn: () => discoverAll(cwd, readSaved()),
        queryKey: [ID, QUERY_KEY, cwd],
        refetchInterval: POLL_MS,
        staleTime: 5_000
      })

      return {
        cwd,
        loading: query.isPending && !query.data,
        pinned: query.data ? query.data.pinned : [],
        workspace: query.data ? query.data.workspace : []
      }
    }

    const ProjectRow = ({ row }) => {
      const badge = row.missing ? (
        jsx(PanelPill, { tone: 'bad', children: 'missing' })
      ) : row.fresh ? (
        jsx(PanelPill, { tone: 'warn', children: 'import' })
      ) : row.branch ? (
        jsx(PanelPill, { tone: 'muted', children: row.branch.slice(0, 14) })
      ) : null

      return jsx(PanelListRow, {
        active: false,
        icon: row.origin === 'worktree' ? 'git-branch' : 'folder',
        menuItems: menuItemsFor(row),
        meta: badge,
        onSelect: () => void openProject(row),
        rowKey: row.dir,
        title: jsxs('span', {
          children: [
            row.name,
            jsx('span', { style: S.rowPath, children: `  ${shortPath(row.dir)}` })
          ]
        })
      })
    }

    const RowList = ({ rows }) => jsx('div', { children: rows.map(row => jsx(ProjectRow, { key: row.dir, row })) })

    const GodotPane = () => {
      const { cwd, loading, pinned, workspace } = useDiscovery()
      const empty = !loading && workspace.length === 0 && pinned.length === 0

      return jsxs('div', {
        style: S.pane,
        children: [
          jsxs('div', {
            style: S.header,
            children: [
              jsx(Codicon, { name: 'game', size: '0.8rem', style: { opacity: 0.7 } }),
              jsx('span', { style: S.headerTitle, children: 'Godot' })
            ]
          }),
          empty
            ? jsx(PanelEmpty, {
                action: jsx(Button, { onClick: () => void addProject(), size: 'sm', children: 'Add project…' }),
                description: cwd
                  ? `Nothing carrying a ${PROJECT_FILE} was found at ${shortPath(cwd)} or in its worktrees.`
                  : 'This session has no working directory yet.',
                icon: 'symbol-folder',
                title: 'No Godot project here'
              })
            : jsxs('div', {
                style: S.list,
                children: [
                  workspace.length
                    ? jsxs('div', {
                        children: [
                          jsx('div', { style: S.section, children: jsx(PanelSectionLabel, { children: 'this workspace' }) }),
                          jsx(RowList, { rows: workspace })
                        ]
                      })
                    : null,
                  pinned.length
                    ? jsxs('div', {
                        children: [
                          jsx('div', { style: S.section, children: jsx(PanelSectionLabel, { children: 'saved' }) }),
                          jsx(RowList, { rows: pinned })
                        ]
                      })
                    : null,
                  jsx(PanelAddButton, { label: 'Add Godot project…', onClick: () => void addProject() })
                ]
              }),
          jsxs('div', {
            style: S.hint,
            children: [
              'Click a row to open that project in the Godot editor. Rows with an ',
              jsx(PanelPill, { tone: 'warn', children: 'import' }),
              ' badge have no .godot cache yet — right-click for the import prompt.'
            ]
          })
        ]
      })
    }

    const WorkspaceChip = () => {
      const { loading, workspace } = useDiscovery()
      const row = workspace.find(candidate => candidate.origin === 'cwd') || workspace[0]
      const label = loading ? 'Godot' : row ? `Open ${row.name} in Godot` : 'No Godot project in this workspace'

      return jsx(Tip, {
        children: jsxs('button', {
          'aria-label': label,
          className: chipClass,
          onClick: () => void (row ? openProject(row) : openWorkspaceProject()),
          type: 'button',
          children: [
            jsx(Codicon, { name: 'game', size: '0.75rem' }),
            jsx('span', { children: 'godot' })
          ]
        }),
        label
      })
    }

    // --- which workspace are we in? ---------------------------------------
    // `host.state.cwd` is the SELECTED conversation's path, and the app
    // deliberately keeps the previous conversation's value across a switch
    // until the new workspace is confirmed (the marker that says so is
    // internal). Judging it directly left a Godot workspace's chrome up while
    // the user sat in another chat. So judge the FOCUSED chat's own cwd: the
    // per-session value the backend reported for it when we have one, else the
    // workspace atom only once it actually moves for this chat.

    const focusedIds = () => ({
      runtime: host.state.focusedSessionId.get() || '',
      stored: host.state.focusedStoredSessionId.get() || ''
    })

    const focusKey = () => {
      const { runtime, stored } = focusedIds()

      return `${stored}|${runtime}`
    }

    const ownCwdOf = ({ runtime, stored }) => {
      if (stored && sessionCwds.has(stored)) {
        return sessionCwds.get(stored)
      }

      if (runtime && sessionCwds.has(runtime)) {
        return sessionCwds.get(runtime)
      }

      return undefined
    }

    const hasFocus = ({ runtime, stored }) => Boolean(runtime || stored)

    // `session.info` only arrives when the backend has something to say about a
    // session, so a chat that is already live and idle can stay unknown for as
    // long as we watch it. `projects.tree` is the app's own per-session
    // workspace source — the sidebar tree and the focused-workspace resolution
    // both read it — and it is read-only, so ask it instead of waiting.
    const TREE_MIN_INTERVAL_MS = 3_000
    let treeAskedAt = 0
    let treeAskedFor = ''
    let treeAsk = null

    const indexTree = tree => {
      const projects = tree && Array.isArray(tree.projects) ? tree.projects : []
      let found = 0

      for (const project of projects) {
        const sessions = project && Array.isArray(project.previewSessions) ? project.previewSessions : []

        for (const session of sessions) {
          const cwd = typeof session?.cwd === 'string' && session.cwd ? session.cwd : session?.git_repo_root

          if (!session?.id || typeof cwd !== 'string' || !cwd) {
            continue
          }

          const keys = [session.id, session._lineage_root_id, ...(session._lineage_ids ?? [])]

          for (const key of keys) {
            if (key && sessionCwds.get(key) !== cwd) {
              sessionCwds.set(key, cwd)
              found += 1
            }
          }
        }
      }

      return found
    }

    /** Ask the backend which workspace the live chats have — once per chat, and
     *  no more than once every few seconds (so a chat that has no workspace of
     *  its own is re-checked but never hammered). Resolves to the in-flight
     *  request when one is already running. */
    const ensureSessionCwds = () => {
      if (treeAsk) {
        return treeAsk
      }

      const focus = focusKey()
      const stale = Date.now() - treeAskedAt >= TREE_MIN_INTERVAL_MS

      if (focus === treeAskedFor && !stale) {
        return null
      }

      treeAskedFor = focus
      treeAskedAt = Date.now()
      treeAsk = host
        .request('projects.tree', { preview_limit: 50 })
        .then(indexTree)
        .catch(() => 0)
        .finally(() => {
          treeAsk = null
        })

      return treeAsk
    }

    /** Record what we settled on for the focused chat. Switching away and back
     *  must not depend on another `session.info` happening to arrive — a chat we
     *  have already judged keeps its workspace. */
    const rememberFocusedCwd = cwd => {
      if (!cwd) {
        return
      }

      const ids = focusedIds()

      for (const key of [ids.stored, ids.runtime]) {
        if (key) {
          sessionCwds.set(key, cwd)
        }
      }
    }

    // At load the workspace atom IS the app's belief for the chat on screen
    // (seeded from memory / that session's own activate), so record it for that
    // chat. Without this the chat that was already open when the plugin loaded
    // has no per-session cwd at all and reads as "unknown" for as long as no
    // `session.info` happens to arrive for it.
    const seedFocusedCwd = () => rememberFocusedCwd(host.state.cwd.get())

    seedFocusedCwd()

    // At load the app is settled: whatever the atom holds describes the chat on
    // screen, so that is the starting belief.
    let settledFocus = focusKey()
    let settledCwd = host.state.cwd.get()
    let lastAtomCwd = settledCwd
    let settledHadFocus = hasFocus(focusedIds())

    const resolvedCwd = () => {
      const atomCwd = host.state.cwd.get()
      const ids = focusedIds()
      const focus = focusKey()
      const own = ownCwdOf(ids)
      const isReal = hasFocus(ids)

      if (focus !== settledFocus) {
        // A REAL conversation switch. The focus atoms also hydrate from empty
        // to the open chat a moment after load, and that is not a switch — it
        // must not blank a workspace the app has already published.
        if (settledHadFocus && isReal) {
          settledCwd = null
        }

        settledFocus = focus
        settledHadFocus = isReal
      }

      if (atomCwd !== lastAtomCwd) {
        lastAtomCwd = atomCwd
        settledCwd = atomCwd
      }

      if (own !== undefined) {
        settledCwd = own
      }

      return settledCwd ?? ''
    }

    // --- contributions ----------------------------------------------------
    // The chip and the pane are chrome for a Godot workspace, so they exist
    // only while there is something to act on: an unregistered pane id drops
    // out of the tab strip while the layout keeps its slot, so the pane returns
    // to the same place the moment a Godot project does. The ⌘K rows stay
    // registered — they are the door to *add* a project, and the palette only
    // shows them when asked.

    let disposePane = null
    let disposeChip = null
    let gateKey = ''
    // Triggers overlap (the cwd atom, the focus atoms and a `session.info` can
    // all land in the same tick), and the probe below awaits. Without a token a
    // run that computed its cwd BEFORE an event landed could resume after the
    // run that saw it, and re-apply the stale view.
    let gateToken = 0

    const syncGate = async () => {
      const token = (gateToken += 1)

      // Ask the backend about the focused chat when we have never learned its
      // workspace, and again on every switch (a chat can move between repos —
      // the tree is the backend's truth, so a stale memory must not outlive a
      // switch). The ask itself is deduped and rate-limited.
      const ids = focusedIds()

      if (hasFocus(ids) && (treeAskedFor !== focusKey() || ownCwdOf(ids) === undefined)) {
        await ensureSessionCwds()

        if (token !== gateToken) {
          return
        }
      }

      const first = resolvedCwd()
      let hasProject = Boolean(first) && Boolean(await findProjectDir(first))

      if (token !== gateToken) {
        return
      }

      // Re-resolve: focus or the workspace may have moved while we probed.
      const cwd = resolvedCwd()

      if (cwd !== first) {
        hasProject = Boolean(cwd) && Boolean(await findProjectDir(cwd))

        if (token !== gateToken) {
          return
        }
      }

      rememberFocusedCwd(cwd)

      const saved = readSaved()
      const key = `${cwd}|${hasProject}|${saved.length}`

      if (key === gateKey) {
        return
      }

      gateKey = key
      $godotGate.set({ cwd, hasProject })

      // A saved project keeps the pane reachable from a chat that is not itself
      // a Godot project — that list is the reason it was saved.
      const showPane = hasProject || saved.length > 0

      if (showPane && !disposePane) {
        disposePane = ctx.register({
          area: 'panes',
          data: { placement: 'right', width: '258px' },
          id: 'pane',
          render: () => jsx(GodotPane, {}),
          title: 'godot'
        })
      } else if (!showPane && disposePane) {
        disposePane()
        disposePane = null
      }

      if (hasProject && !disposeChip) {
        disposeChip = ctx.register({
          area: 'statusBar.right',
          id: 'chip',
          order: 140,
          render: () => jsx(WorkspaceChip, {})
        })
      } else if (!hasProject && disposeChip) {
        disposeChip()
        disposeChip = null
      }
    }

    // The cwd atom fires immediately and on every session switch; the interval
    // is the safety net for a project appearing or vanishing on disk under an
    // unchanged cwd (a worktree checkout, a clone that finished). `session.info`
    // is what tells us a chat's OWN workspace, including chats we are not in —
    // and the focus atoms are what notice the switch itself, so the chrome goes
    // the moment the user lands in another chat rather than at the next poll.
    ctx.setInterval(() => void syncGate(), GATE_POLL_MS)
    ctx.onDispose(host.state.cwd.listen(() => void syncGate()))
    ctx.onDispose(host.state.focusedStoredSessionId.listen(() => void syncGate()))
    ctx.onDispose(host.state.focusedSessionId.listen(() => void syncGate()))
    ctx.onDispose(host.state.activeSessionId.listen(() => void syncGate()))
    ctx.onEvent('session.info', event => {
      const payload = event && event.payload

      if (!payload || typeof payload.cwd !== 'string') {
        return
      }

      const keys = [payload.stored_session_id, event.session_id].filter(
        key => typeof key === 'string' && key
      )

      if (!keys.length) {
        return
      }

      let changed = false

      for (const key of keys) {
        if (sessionCwds.get(key) !== payload.cwd) {
          sessionCwds.set(key, payload.cwd)
          changed = true
        }
      }

      if (changed) {
        void syncGate()
      }
    })
    void syncGate()

    ctx.register({
      area: 'palette',
      data: {
        icon: icons.MonitorPlay,
        id: `${ID}.openWorkspace`,
        keywords: ['godot', 'open', 'editor', 'project', 'workspace', 'game'],
        label: 'Godot: open the workspace project',
        run: () => void openWorkspaceProject()
      },
      id: 'openWorkspace',
      order: 610
    })

    ctx.register({
      area: 'palette',
      data: {
        icon: icons.FolderOpen,
        id: `${ID}.addProject`,
        keywords: ['godot', 'add', 'project', 'folder', 'choose'],
        label: 'Godot: add a project…',
        run: () => void addProject()
      },
      id: 'addProject',
      order: 611
    })

    ctx.register({
      area: 'palette',
      data: {
        icon: icons.RefreshCw,
        id: `${ID}.refresh`,
        keywords: ['godot', 'refresh', 'reload', 'rescan'],
        label: 'Godot: rescan projects',
        run: () => {
          refresh()
          notify('info', 'Rescanning Godot projects')
        }
      },
      id: 'refresh',
      order: 612
    })
  }
}
