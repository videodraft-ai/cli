# Native VideoDraft Editor reference

Use this reference when the user wants to assemble, cut, caption, mix, lay out, inspect, or export a local VideoDraft Editor project. The native editor is deterministic and local. Cloud generation remains in the `videodraft` CLI or hosted MCP.

## VideoDraft ADE preference rule

When `videodraft_editor` tools are exposed, treat the native editor as available and make it the default surface for production, timeline assembly, and final export. It is headless by design, so a hidden window or an untouched Open Editor button does not justify using hosted production instead.

Use cloud tools for asset generation and optional script/storyboard work, then import the results. Do not call hosted `produce_project` / `videodraft produce` or `export_video` / `videodraft export` unless the user explicitly requests an editable web production or the native editor tools are unavailable. If a native tool call fails after the editor was available, report or recover that native failure rather than silently switching surfaces.

## Choose the correct surface

- `videodraft` and the hosted VideoDraft MCP generate assets and can manage hosted web projects. They use the user's VideoDraft account and credits. In VideoDraft ADE, use them mainly as the source of generated media and optional storyboards for the native production.
- `videodraft_editor` edits local `.vdproject` packages. It has no generation, account, model, or credit tools.
- Inside VideoDraft ADE on a supported Mac, the editor MCP is injected automatically for Claude, Codex, OpenCode and Grok in both Code and VideoDraft modes. It starts headlessly before the chat opens. The user does not need to click Open Editor, and closing or hiding the editor window does not stop headless editing.
- Outside that environment, use the editor only if `videodraft_editor` MCP tools are already exposed or the `videodraft-editor` executable is on PATH. Do not confuse the public `videodraft` cloud CLI with the separate native editor executable.

Prefer the direct MCP tools when they are available. The terminal bridge is useful for scripts, diagnostics, or an agent session where the MCP was not injected.

## Which editor tools you have

Current editors expose eight workflow tools: `project_manage`, `edit_snapshot`, `edit_apply`, `edit_undo`, `library_manage`, `inspect`, `speech_apply`, and `delivery_manage`. Use them whenever `edit_apply` is available. Everything below describes them.

Earlier editors expose a different set of tools. If `edit_apply` is not in your catalog, follow the live tool descriptions; the working rules below still apply.

The live tool descriptions and schemas are authoritative. When they differ from this reference, follow them.

Service tools (`project_manage`, `library_manage`, `inspect`, `speech_apply`, `delivery_manage`) take `operation` and `parameters`, plus an optional `context` (see [Keep a reliable editing model](#keep-a-reliable-editing-model)):

```json
{"operation": "import", "parameters": {"source": {"path": "/Users/me/clips"}}}
```

### Parameters at a glance

Each operation's schema has the full list. These are the fields that matter most, and the ones most often confused:

| Tool and operation | Key `parameters` |
| --- | --- |
| `project_manage` `project` | `action` (`list`, `open`, `create`, `close`); `id`, `name` or `path` to open; `name`, `fps`, `aspectRatio`, `quality` to create |
| `edit_snapshot` (no `parameters`) | `includeLibrary`, a `startFrame`/`endFrame` window, `offset`/`limit` paging, `context` for later pages |
| `edit_apply` (no `parameters`) | `actions`; optional `context`, `requestId`, `previewOnly` |
| `library_manage` `import` | `source` with one of `path`, `url`, `bytes` + `mimeType`, or `matte`; optional `name`, `folder`. A `.srt` or `.vtt` file becomes captions |
| `library_manage` `list` | `ids` to poll imports, `pending`, `folder` |
| `inspect` `timeline` | a `startFrame`/`endFrame` window; there is no clip filter |
| `inspect` `frame` | `startFrame` for one frame; add `endFrame` and `maxFrames` to sample a range |
| `inspect` `media` | `mediaRef` (a library asset, not a file path), `startSeconds`/`endSeconds` in source seconds, `wordTimestamps`, `overview` |
| `inspect` `transcript` | a `startFrame`/`endFrame` window, `granularity` (`words` or `segments`), `clipId` |
| `inspect` `color` | `clipId` with `atFrame`, or `mediaRef`; optional `reference` |
| `speech_apply` `words` | `words`: transcript word indices, each one index or a `[first, last]` pair; or `matches`: exact words to remove everywhere; `pacing` |
| `speech_apply` `silence` | none |
| `speech_apply` `captions` | caption `style`, `position` and look fields; it finds the speech itself. `style` `plain` (sentences without a preset) takes `positionY` or `transform.centerY`, not `position` or `punctuation` |
| `delivery_manage` `submit` | `mode`, `codec`, `resolution`, `outputPath` (its folder must already exist); `captionGroupId` and `wordTiming` for `srt` and `vtt`; `check: false` skips a video's export check |
| `delivery_manage` `jobs` | `action` `list` (every job with its progress, warnings, output path and check findings; with a `jobId`, that job with all its findings), `cancel` with a `jobId`, or `dismiss` with a `jobId` and optional `findingIds` |

`previewOnly` exists only on `edit_apply`. Service operations apply immediately.

### `edit_apply` actions at a glance

Every action puts its fields beside `kind`, for example `{"kind": "adjust", "clipId": "c1", "speed": 2}`. `remove`, `adjust`, `replace`, `transition`, `mask`, `text`, `grade` and `effects` take `clipId` for one clip or `clipIds` for several; `animate`, `extract`, and the rows of `move` and `split` take a single `clipId`. Advanced actions cannot take `as`, but their clip ids accept `@name`. The one exception is `transition`, whose own `kind` field names the style, so its fields go inside `parameters`: `{"kind": "transition", "parameters": {"clipId": "c2", "kind": "dipToBlack"}}`. These `actions` place a clip, warm it and add a vignette:

```json
[{"kind": "place", "assetId": "…", "atFrame": 0, "as": "shot"},
 {"kind": "grade", "clipId": "@shot", "adjustments": {"temperature": 7500}},
 {"kind": "effects", "clipId": "@shot", "effects": [{"type": "finish.vignette", "params": {"strength": 35}}]}]
```

| Advanced `kind` | Key fields |
| --- | --- |
| `place_batch` | `entries: [{mediaRef, startFrame, endFrame or source, trackIndex}]`, not the concise `assetId`, `atFrame`, `durationFrames`; leave `trackIndex` off every entry for a new track |
| `insert_batch` | `trackIndex`, `atFrame`, `entries: [{mediaRef, durationFrames or source}]`; later clips move right |
| `move` | `moves: [{clipId, toFrame, toTrack}]` |
| `remove` | `clipId` or `clipIds`; leaves a gap |
| `split` | `splits: [{clipId, atFrame}]`, or `trackIndex` with `frames` |
| `extract` | `trackIndex` with `ranges: [[start, end]]` in frames, or `clipId` with `ranges` and `units` (`frames`, or source `seconds`); closes the gap |
| `adjust` | `clipId` or `clipIds` plus any of `durationFrames`, `trimStartFrame`, `trimEndFrame`, `speed`, `speedCurve` (`{preset}`, or `{points: [{t, rate}]}` with `t` from 0 to 1 along the source), `preservesPitch`, `volume`, `opacity`, `transform` (`centerX`, `centerY`, `width`, `height`, `flipHorizontal`, `flipVertical`), `blendMode` |
| `animate` | `clipId`, `property` (`volume`, `opacity`, `rotation`, `position`, `scale`, `crop`), `keyframes: [[frame, ...values]]` with frames counted from the clip's start; `position` is the top-left corner |
| `arrange` | `layout`, `slots: [{slot, clipIds or mediaRef, anchor}]`, `fit` (`fill` or `fit`); `mediaRef` slots also need `endFrame` |
| `transition` (fields inside `parameters`) | `clipId` or `clipIds` (the clip after each cut), `kind` (`crossDissolve`, `dipToBlack`, `dipToWhite`, `blurDissolve`, `push`, `linearWipe`, `whipPan`, `crossZoom`, or `none` to remove), `durationFrames`, `params` (`direction` 0 to 3 for left, right, up, down; `feather`; `blur`; `intensity`) |
| `mask` | `clipId` or `clipIds`, `shape` (`rectangle`, `ellipse`, `none`), `centerX`, `centerY`, `width`, `height` (0 to 1 of the clip's own frame), `feather`, `strength`, `inverted` |
| `replace` | `clipId` or `clipIds`, `mediaRef` (a library asset of the same kind), `trim` (`keep`, the default, or `reset`), `linkedAudio` (`follow`, the default, or `keep`) |
| `tracks` | `reorder: [{trackId, to}]`, `set: [{trackId, muted, hidden, syncLocked}]`, `remove: [{trackId}]`; there is no add, since placing without a track makes one |
| `titles` | `entries: [{startFrame, endFrame, content}]`, optionally with `trackIndex` (on every entry or none), `style`, `animation`, `transform` and typography (`fontName`, `fontSize`, `color`) |
| `text` | `clipId`, `clipIds` or `captionGroupId`, with `content`, `style`, `position`, `animation` or typography |
| `grade` | `clipId` or `clipIds`, `adjustments`, `wheels`, `curves`, `hueCurves`, `lut`, `reset` |
| `effects` | `clipId` or `clipIds`, `effects: [{type, params, enabled}]`, `remove: [type]` |

- `grade`: `adjustments` holds `exposure` (EV, -4 to 4), `temperature` (kelvin, 1800 to 15000, 6500 neutral, higher is warmer), `tint` (-150 magenta to 150 green); `contrast`, `highlights`, `shadows`, `whites`, `blacks`, `vibrance` and `saturation` are signed percents (-100 to 100, 0 neutral), not factors like 1.2. `wheels`: `shadows`, `midtones`, `highlights`, each `{hue, strength, brightness}`. `curves`: `luma`, `red`, `green`, `blue` as `[x, y]` points from 0 to 1. `hueCurves`: `targets: [{hue, rotate, saturation, lightness}]`. `lut`: `{path, mix}`, with the `storedPath` from `prepare_look`. Out-of-range values are refused.
- Effect `type` ids and their knobs, which go inside `params` and run 0 to 100 unless noted. Defaults leave the picture unchanged, so send the knob you want to see:
  - `finish.vignette`: `strength` and `curvature` (-100 to 100; positive `strength` darkens the edges), `size`, `falloff`
  - `finish.grain`: `strength`, `grainSize` (0.5 to 6 px); `finish.glow`: `strength`, `haloRadius` (px), `cutoff`, `halation`
  - `defocus.gaussian`: `blurRadius` (px); `defocus.motion`: `streakLength` (px), `streakAngle` (-180 to 180 degrees)
  - `texture.clarity`: `localContrast`, `hazeRemoval` (-100 to 100); `texture.sharpen`: `strength` (0 to 200); `texture.denoise`: `strength`
  - `matte.chroma`: `screenHue` (0 to 360 degrees, 120 is green), `range`, `edgeSoftness`, `spillSuppression`
- `arrange` layouts and their slots (fill every slot): `fullscreen` (`stage`); `split` (`left`, `right`); `stack` (`top`, `bottom`); `corner_top_left`, `corner_top_right`, `corner_bottom_left`, `corner_bottom_right` (`stage`, `corner`); `quad` (`top_left`, `top_right`, `bottom_left`, `bottom_right`); `side_panel` (`stage`, `panel`); `thirds` (`left`, `middle`, `right`). The layout picks the corner; `anchor` only biases the crop.
- `trackIndex` and `toTrack` are an existing track's `order` from `edit_snapshot` (0 draws on top), counted at that point in the recipe: a track an earlier action adds shifts them. `tracks` takes `trackId` handles instead.

## Start with the intended project

An MCP session can begin without a project selected. Project selection belongs to the session, not to whichever editor window happens to be frontmost.

1. If the user named an existing project but its identity is unclear, call `project_manage` with `operation: "project"` and `parameters.action: "list"`.
2. Open the exact project with `action: "open"` and the returned `id`, an unambiguous `name`, or the `.vdproject` `path`.
3. Create only when the user wants a new local edit. `action: "create"` accepts optional `name`, `fps`, `aspectRatio`, and `quality`.
4. Treat `isActive` as this session's target and `isVisible` as the project shown in the UI. Headless editing only needs the session target.
5. Use `action: "close"` only when closing is part of the task. It saves first and never deletes the project. Afterwards other calls answer `no_project` until you open or create a project again.
6. Your session edits its own project even while another project's window is in front. If the user says "this clip" or "here" and `edit_snapshot` has no `selection`, or `selection.visible` is false, they are looking at something else: ask before editing. An older editor may instead refuse the write because another project is in front; tell the user rather than taking the front yourself. Never change which project is in front with Computer Use or other UI automation.

Other `project_manage` operations: `create_timeline` and `select_timeline` for additional timelines, and `configure` for project settings (a frame-rate change applies to every timeline).

Do not substitute a hosted project ID for a native project. A hosted project can supply scripts, storyboards, and generated media, but the native edit is a separate `.vdproject` package.

## Keep a reliable editing model

- Opening or creating a project, and creating or selecting a timeline, returns `data.snapshot` (the `edit_snapshot` view with the library: format, tracks, clips and assets) and a `context`, so you can edit right away. Call `edit_snapshot` only after an out-of-band user edit, to page a long timeline with `offset` and `limit`, or for handles you lack.
- `context` (`epoch`, `timelineId`, `revision`) is optional on every write except `edit_undo` and `project_manage` `project`, which take none. Without it, a write applies to the current state. With it, the editor refuses the write if the project changed since that context, which is what you want when a person may be editing at the same time. Every reply returns a fresh `context`. After `context_expired` (a reopen or restart), take a new snapshot.
- Timeline positions and durations are frames at `format.fps`. `sourceSeconds` values are seconds in the source file. Pass values as returned; do not multiply or divide by fps yourself.
- IDs are short handles. Pass them back exactly as returned; do not derive them from UUIDs. Tracks keep stable handles; indexes can change.
- When the user says "this clip", "these captions", or "here", take a fresh `edit_snapshot` (a one-frame window is enough). Its `selection` names what they selected in the project's window, in the snapshot's handles: `clipIds`, `captionGroupIds`, a `gap`, the marked `range`, and library `mediaIds`; no `selection` means nothing is selected. `currentFrame` is the playhead. `visible: false` means the user is not looking at this project.
- Send writes serially. Parallel writes against one project race each other's context.
- A refused call answers `status: "rejected"`: nothing changed, so fix what the message names and send it again. A service write that answers `failed` may have applied before a save or connection failed; inspect before repeating it.
- Use `inspect` for detail and verification: `timeline` for exact clip and track properties, `frame` for rendered frames of the composited result, `media` before describing source content, `color` for scopes, and `transcript` to locate spoken words.
- Clip `volume` is linear gain: `0` is silent, `1` plays the clip as recorded, and up to `5.62` (+15 dB) boosts it. Volume keyframes stay `0` to `1`. Boost sparingly and read the export check, which reports clipping.

## Edit with recipes

`edit_apply` takes an ordered list of `actions`, plus an optional `context` and `requestId`. The editor validates the whole recipe before changing anything, then applies it as one undo step. If any action fails, nothing changes and the error names the action. An applied reply lists the resulting `clips` (position, length, source window, text); use it to confirm the edit instead of re-reading.

- Concise actions: `place` (an `assetId` at `atFrame`, optionally on a `trackId`, with `durationFrames` or `sourceSeconds`, `mode` `overwrite` or `insert`), `trim` (a `clipId` to a `sourceSeconds` window), and `title` (`text` at `atFrame` for `durationFrames`, optional `look` and `motion`). Name an action with `as` and address its clip in later actions as `@name`.
- Advanced actions put their fields beside `kind` too: `place_batch`, `insert_batch`, `move`, `remove`, `split`, `extract`, `adjust`, `animate`, `arrange`, `transition` (fields inside `parameters`), `mask`, `replace`, `tracks`, `titles`, `text`, `grade`, and `effects`. Their field help lists every supported effect, grading control, mask, layout, speed curve, and caption control.
- Use `arrange` for split screens, picture-in-picture, grids, and canvas placement, and `tracks` to fix stacking. Do not synthesize layouts from generic transforms or keyframes.
- Use `replace` to swap a clip's media and keep its timing, effects, keyframes, and links, for example a re-render of the same shot. `trim: "keep"` holds the clip's source offsets; `trim: "reset"` plays the new media from its first frame and keeps linked audio in sync.
- Put every edit a request needs into one recipe: placing, trimming, titling, grading and effects together are one call and one undo step. Use `previewOnly: true` to validate a large or risky recipe without editing.
- Send a `requestId` when a retry must not edit twice: repeating the identical request with the same `requestId` returns the original receipt, even after a dropped connection. Without one, a repeated request applies again. Use a new `requestId` for a different edit.
- `applied_unsaved` means the edit applied but saving failed. If you sent your own `requestId`, repeat the identical request to retry the save, not the edit. Without one, do not resend: a repeat would apply the edit again.
- `edit_undo` reverses this connection's latest edit while it is still the top undo step. It never undoes the user's own edits. Take a new snapshot afterward.

Edits are undoable. Do not ask for confirmation before each ordinary edit. Ask one focused question only when the user's creative direction is materially ambiguous.

## Bring generated or local media into the editor

For b-roll and establishing shots, search free stock first (`videodraft stock search "<query>"`), import the pick with `videodraft stock import <ref>`, and feed the returned CDN URL to `library_manage` `import` as `source.url`. It costs no credits.

Otherwise use cloud generation for new assets, save or download the outputs, then call `library_manage` with `operation: "import"`:

- `source.path`: absolute local file or directory. A directory imports recursively and preserves its folder structure.
- `source.url`: HTTPS asset URL. Set `mimeType` when a signed URL has no usable extension.
- `source.bytes`: small base64 media with a required `mimeType`.
- `source.matte`: generated solid-color image.

Readiness differs by source, and so does the poll that detects it:

- **URL and single-file path** imports return `status: "downloading"` with one `mediaRef`. Poll `library_manage` `list` with `parameters.ids: [mediaRef]` until `generationStatus` is absent.
- **Directory** imports also return `status: "downloading"` with one placeholder `mediaRef` for the batch. Poll it the same way; the folder's assets appear when `generationStatus` clears. (`pending: true` remains a fallback that lists every unresolved import.)
- **Inline bytes and matte** imports finish inline and come back `status: "ready"`; no polling is needed.

An import's `mediaRef` is the `assetId` that recipe actions take. Never place a pending asset on the timeline. `generationStatus` is the signal: `preparing`, `generating`, `downloading`, and `rendering` mean keep polling, absent means usable, and **`failed` is terminal**. Report it or retry the import explicitly; never poll on. Do not treat "not downloading" as ready.

A `.srt` or `.vtt` caption file (by `path`, `url`, or `bytes` with `mimeType` `application/x-subrip`, `text/srt`, or `text/vtt`) is not added to the library. Its captions go onto a new caption track at the times the file gives, as one undo step, and the reply names the new `captionGroupId` to restyle with a `text` action.

For a batch of local outputs, download them into one workspace directory and import that directory once when practical. This is safer and faster than racing many import calls.

To apply a LUT, first store it with `library_manage` `prepare_look` (`parameters.path` to a `.cube` file), then use the returned `storedPath` in a `grade` action.

## Speech edits

`speech_apply` runs speech work as separate operations, not recipe actions: `words` removes transcript words, `silence` trims dead air, and `captions` generates styled captions. Read a fresh transcript with `inspect` `transcript` after any speech edit, because word positions change.

## Service operations and timeouts

`project_manage`, `library_manage`, `speech_apply`, and `delivery_manage` writes have no retry receipts. After a timeout, inspect the outcome (a snapshot, a library `list`, or delivery `jobs`) before repeating a write. A failed service write may have applied an edit before saving failed, so read its `data` and the current state.

## Edit and verify

A dependable sequence:

1. `project_manage` to select or create the local project; its reply carries the snapshot.
2. `inspect` `media` when content selection matters.
3. One `edit_apply` recipe with every clip, track, layout, text, audio, color, and effect change the request needs; `speech_apply` for word cuts, silence, and captions.
4. Check the reply's `clips`; use `inspect` `frame` only when visual composition or layer order matters.
5. `edit_undo` if the result is wrong and the next recipe would not cleanly correct it.

## Export

Call `delivery_manage` with `operation: "submit"`. Submission is not completion: it returns a job, destination, and `started` or `queued` status.

- Use `mode: "video"` for H.264, H.265, or ProRes.
- Use `mode: "xml"` (XMEML) for Premiere Pro **and DaVinci Resolve**. Resolve reads XMEML natively. Use `fcpxml` only for Final Cut Pro; sending Resolve an FCPXML produces a package it cannot open cleanly.
- Use `mode: "videodraft"` for a self-contained project package.
- Use `mode: "srt"` or `mode: "vtt"` for a subtitle file of the captions: words and timing only, without styling. `captionGroupId` picks a caption group; `wordTiming: true` adds each word's start to a `vtt`.
- Omit `outputPath` unless the user named a destination; the default is `~/Downloads`. The editor does not create folders, so a named destination's folder must already exist.
- Use `operation: "jobs"` with `parameters.action` `list` to follow progress, warnings, and results. Cancel only when the user asks or the just-queued settings were wrong. Do not infer that an export is stuck from elapsed time alone.
- A finished video export is then checked in the background for black picture, gaps, sound that drops out or clips, and missing media. `list` shows each job's `findingCount` and its first three findings; `list` with that `jobId` returns every finding. Findings are warnings on a completed export: tell the user what was found and where, rather than treating the export as failed.

## Terminal bridge

VideoDraft desktop terminals expose `videodraft-editor`, which controls the same process and tools:

```bash
videodraft-editor status
videodraft-editor list-tools
videodraft-editor tool project_manage --json '{"operation":"project","parameters":{"action":"list"}}'
videodraft-editor tool edit_snapshot --project "/path/to/My Video.vdproject" --json '{"includeLibrary":true}'
videodraft-editor show
videodraft-editor hide
```

Each `videodraft-editor` invocation is a separate connection, so a project opened by one call is NOT remembered by the next. Pass `--project <path>` on every `tool` call that operates on a project; without it, a follow-up call answers `no_project` (no project is open for this session) even though the open succeeded. For the same reason, `edit_undo` has nothing to undo from the terminal: it only reverses an edit made on its own connection.

Control and tool commands auto-start a headless editor if none is running. `show` only reveals the already-running UI. Use `videodraft-editor tool <name> --json -` to read a JSON object from stdin when shell quoting would be fragile. Never read, copy, or expose the editor's rotating local authentication secret.
