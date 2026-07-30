# Native VideoDraft Editor reference

Use this reference when the user wants to assemble, cut, caption, mix, lay out, inspect, or export a local VideoDraft Editor project. The native editor is deterministic and local. Cloud generation remains in the `videodraft` CLI or hosted MCP.

## VideoDraft ADE preference rule

When `videodraft_editor` tools are exposed, treat the native editor as available and make it the default surface for production, timeline assembly, and final export. It is headless by design, so a hidden window or an untouched Open Editor button does not justify using hosted production instead.

Use cloud tools for asset generation and optional script/storyboard work, then import the results. Do not call hosted `produce_project` / `videodraft produce` or `export_video` / `videodraft export` unless the user explicitly requests an editable web production or the native editor tools are unavailable. If a native tool call fails after the editor was available, report or recover that native failure rather than silently switching surfaces.

## Choose the correct surface

- `videodraft` and the hosted VideoDraft MCP generate assets and can manage hosted web projects. They use the user's VideoDraft account and credits. In VideoDraft ADE, use them mainly as the source of generated media and optional storyboards for the native production.
- `videodraft_editor` edits local `.vdproject` packages. It has no generation, account, model, or credit tools.
- Inside VideoDraft ADE on a supported Mac, the editor MCP is injected automatically for Claude and Codex in both Code and VideoDraft modes. It starts headlessly before the chat opens. The user does not need to click Open Editor, and closing or hiding the editor window does not stop headless editing.
- Outside that environment, use the editor only if `videodraft_editor` MCP tools are already exposed or the `videodraft-editor` executable is on PATH. Do not confuse the public `videodraft` cloud CLI with the separate native editor executable.

Prefer the direct MCP tools when they are available. The terminal bridge is useful for scripts, diagnostics, or an agent session where the MCP was not injected.

## Start with the intended project

An MCP session can begin without a project selected. Project selection belongs to the session, not to whichever editor window happens to be frontmost.

1. If the user named an existing project but its identity is unclear, call `manage_project` with `action:'list'`.
2. Open the exact project by the returned `id`, unambiguous `name`, or `.vdproject` `path`.
3. Create only when the user wants a new local edit. `action:'create'` accepts optional `name`, `fps`, `aspectRatio`, and `quality`.
4. Treat `isActive` as this MCP session's target and `isVisible` as the project shown in the UI. Headless editing only needs the session target.
5. Use `action:'close'` only when closing is part of the task. It saves first and never deletes the project.

Do not substitute a hosted project ID for a native project. A hosted project can supply scripts, storyboards, and generated media, but the native edit is a separate `.vdproject` package.

## Keep a reliable editing model

- Call `get_timeline` once after opening or creating a project, after switching timelines, or after an out-of-band user edit. It returns the revision and current clip/track state.
- Call `get_media` before using a `mediaRef`. Poll imports with a filtered read (`ids` for a known asset, `pending:true` for a batch) instead of repeatedly loading the full library.
- Timeline placement uses project frames. Source spans, media durations, transcript segments, search hits, and beat times use seconds. Pass those values to the relevant tools as returned; do not multiply by fps yourself.
- IDs are short stable prefixes. Pass them back exactly as returned. Tracks use stable `trackId` values; indexes can change.
- Send project mutations serially. Pass `expectedRevision` from the latest read or mutation when available, then replace it with the fresh revision from the next result. Parallel edits against one project can race or invalidate each other's revision.
- Every mutation returns a delta in `get_timeline` vocabulary. Patch your working model from that delta instead of re-reading after every successful call. Re-read after a stale-state failure or an out-of-band change.
- Use `apply_layout` for split screens, picture-in-picture, grids, and canvas placement. Use `manage_tracks` to fix stacking. Do not synthesize layouts from generic transforms or keyframes.
- Use `inspect_media` before describing source content. Use `search_media` to locate a visual or spoken moment. Use `inspect_timeline` to verify the composited result the viewer will actually see.
- Volume inputs, including volume keyframes, are linear values from `0` to `1`. Timeline reads return the same linear scale.

## Bring generated or local media into the editor

Use cloud generation for new assets, save or download the outputs, then call native `import_media`:

- `source.path`: absolute local file or directory. A directory imports recursively and preserves its folder structure.
- `source.url`: HTTPS asset URL. Set `mimeType` when a signed URL has no usable extension.
- `source.bytes`: small base64 media with a required `mimeType`.
- `source.matte`: generated solid-color image.

Readiness differs by source, and so does the poll that detects it:

- **URL and single-file path** imports return `status:'downloading'` with one `mediaRef`. Poll `get_media` with `ids:[mediaRef]` until `generationStatus` is absent.
- **Directory** imports return `status:'preparing'` once the batch is registered — not ready. A batch has no single `mediaRef` to poll by, so poll `get_media` with `pending:true` until it reports no unresolved imports.
- **Inline bytes and matte** imports finish inline and come back `status:'ready'`; no polling needed.

Never place a pending asset on the timeline. `generationStatus` is the signal: `preparing` and
`downloading` mean keep polling, absent means usable, and **`failed` is terminal** — report it or
retry the import explicitly, never poll on. Do not treat "not downloading" as ready.

For a batch of local outputs, download them into one workspace directory and import that directory once when practical. This is safer and faster than racing many import calls; just remember it is the `pending:true` poll that tells you when the batch is usable.

## Edit and verify

Use the tool descriptions as the exact schema. A dependable sequence is:

1. `manage_project` to select or create the local project.
2. `get_timeline` and `get_media` to establish current state.
3. `inspect_media` or `search_media` when content selection matters.
4. Serialized clip, track, layout, text, caption, audio, color, effect, or cut mutations using the current revision.
5. `inspect_timeline` when visual composition or layer order matters.
6. `undo` if the requested result is wrong and the next mutation would not cleanly correct it.

Edits are undoable. Do not ask for confirmation before each ordinary edit. Ask one focused question only when the user's creative direction is materially ambiguous.

## Export

`export_project` queues work in the background and returns a `jobId`, destination, and `started` or `queued` status.

- Use `video` for H.264, H.265, or ProRes.
- Use `xml` for Premiere Pro.
- Use `xml` (XMEML) for Premiere Pro **and DaVinci Resolve** — Resolve reads XMEML natively.
  Use `fcpxml` only for Final Cut Pro. Sending Resolve an FCPXML produces a package it cannot
  open cleanly, so the target matters more than the file extension suggests.
- Use `videodraft` for a self-contained project package.
- Omit `outputPath` unless the user named a destination; the default is `~/Downloads`.
- Use `manage_exports` to list progress, warnings, and results. Cancel only when the user asks or the just-queued settings were wrong. Do not infer that an export is stuck from elapsed time alone.

## Terminal bridge

VideoDraft desktop terminals expose `videodraft-editor`, which controls the same process and MCP surface:

```bash
videodraft-editor status
videodraft-editor list-tools
videodraft-editor tool manage_project --json '{"action":"list"}'
videodraft-editor tool get_timeline --json '{}'
videodraft-editor show
videodraft-editor hide
```

Control and tool commands auto-start a headless editor if none is running. `show` only reveals the already-running UI. Use `videodraft-editor tool <name> --json -` to read a JSON object from stdin when shell quoting would be fragile. Never read, copy, or expose the editor's rotating local authentication secret.
