# Changelog

All notable changes to the `videodraft` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## [Unreleased]

## [0.9.0]

### Added

- Added Black Forest Labs FLUX 3 to video generation, model selection, and cost
  estimates: 5-20 second clips at 720p (17 cr/s) or 1080p (29 cr/s) with native
  audio, from a prompt, a first frame, first + last frames, or keyframes.
- Added `--keyframe <url|file@seconds>` to `generate video` (repeatable, up to
  10) for FLUX 3 keyframes mode, which pins images to exact moments in the
  generated clip. Local files are uploaded like `--ref`, and the position is
  parsed off the last `@` so signed URLs containing one still work.
- Added the FLUX 3 draft tier via `--quality draft`, which renders the same shot
  at 720p for 6 cr/s. Useful for checking blocking before committing to a
  Standard render. `--estimate` reflects the tier.

### Changed

- The bundled `videodraft` skill now covers FLUX 3 model selection, its 5-20s
  range, the keyframes workflow, and when to reach for the draft tier.

## [0.8.0]

### Added

- Added Grok Imagine Video 1.5 text, first-frame, and 1-7 reference-image
  generation with 1-15 second durations, native audio, 480p/720p/1080p
  text/first-frame output, 480p/720p reference output, and image-aware cost
  estimates.
- Added MiniMax H3 to video generation and model-cost estimates, including
  text, first/last-frame, and mixed-reference inputs. H3 estimates account for
  output duration, reference-image count, and combined reference-video duration.
- Added `--ref-video-seconds` to `generate video --estimate` and
  `videodraft costs` for exact H3 reference-video estimates before upload.

## [0.7.1]

### Changed

- The bundled `videodraft` skill's editor reference now matches the shipped
  native editor surface: the noun-first tool names (`timeline_read`,
  `clips_place`, `canvas_arrange`, `color_grade`, `project_control`, ...),
  the `ifRevision` concurrency guard (formerly `expectedRevision`), and the
  renamed mutation-delta keys.

### Removed

- The editor reference no longer describes beat times (the native editor's
  `detect_beats` tool is withdrawn for now) or the `search_media` tool, which
  dated from the withdrawn smart-search preview; transcript lookup belongs to
  `get_transcript`.

## [0.7.0]

### Added

- New `references/editor.md` skill reference covering the native VideoDraft
  Editor (headless `videodraft_editor` MCP): project selection, media import,
  timing units, revision-guarded mutations, verification, export, and the
  `videodraft-editor` terminal bridge.
- `videodraft skills show editor` prints the new reference (alongside the
  existing `skill | examples | models | pipeline` sections).

### Changed

- The `videodraft` skill now routes ADE-first: when the native editor MCP is
  exposed, production, timeline assembly, and export default to the native
  editor, with hosted production/export reserved for explicit requests or as a
  fallback. Fixed four routing errors that could misdirect agents into the
  hosted pipeline.
- Renamed "VideoDraft desktop app" to "VideoDraft ADE" across CLI copy,
  comments, and skill content.

## [0.6.0]

### Added

- Downloaded images over 500KB now also get a downscaled copy in a `previews/`
  directory beside them, surfaced as a `preview` field in JSON output and an
  "inspect via preview" line in human output. Agents should inspect the preview
  and deliver the original: viewing a full-resolution image re-sends it with
  every later message of the chat. Applies to `generate`, `jobs`, `pipeline`,
  and `media download`. Previews are downscaled locally with `sips` on macOS,
  falling back to the image optimizer for `cdn.videodraft.ai` sources.

### Fixed

- Previews keyed off the basename alone, so `shot.png` and `shot.jpg` resolved
  to the same preview file. The original's full name is now preserved
  (`shot.png` → `previews/shot.png.jpg`).
- A preview could outlive the original it described. Every preview variant for
  a path is now dropped when a new file lands there, including when the
  replacement is too small to earn one or generation fails.
- Preview generation is bounded: `sips` gets a 10s timeout, the optimizer fetch
  drops from 30s to 10s, and the optimizer route is skipped after two
  consecutive failures so multi-output jobs don't pay a timeout per file.

## [0.5.0]

### Added

- Added `videodraft generate audio` for ByteDance Seed Audio 1.0, including preset/custom voices, up to three local or remote audio references, image conditioning, output format and sample-rate controls, speed, volume, pitch, estimates, downloads, and AI Studio project/session grouping.
- Added retry-safe audio idempotency across the CLI, MCP tool, in-app agent, AI Studio, credit reservation, provider execution, and generation persistence.

## [0.4.1]

### Fixed

- Added `--scene` and `--shot` to specialized video edit and motion commands,
  validated them as non-negative indices, and forwarded the scope so project
  outputs stay attached to the requested shot.

## [0.4.0]

### Added

- Added first-class `videodraft edit video` commands for Gemini Omni Flash,
  Kling O3, Grok Imagine, Happy Horse, and Wan 2.7 reference editing, including
  local source/reference uploads, project/scene/shot scope, JSON output, cost
  estimates, and downloads.
- Added specialized avatar and lip-sync commands for VEED Fabric and Sync Labs,
  with audio/text modes, resolution and sync controls, and async job polling.
- Exposed AI Studio's video-editing, avatar, lip-sync, motion-control, audio,
  image/video upscaling, and exact generation model choices through CLI help
  and the grouped tool catalog.

### Changed

- Model-free image and video generation now chooses a model from the requested
  task and inputs. Explicit model selections still pass through unchanged.
- Expanded generation flags for start/end frames, image/video/audio references,
  scene and shot placement, native audio, quality tiers, multi-prompt video,
  and model-specific duration and resolution controls.
- Reworked the bundled VideoDraft skill and model references around concise,
  task-aware defaults: Nano Banana and GPT Image 2 for images, Gemini Omni
  Flash for most video work, Seedance 2 for multimodal references, Kling or
  Seedance for longer native-audio clips, ElevenLabs for speech and effects,
  and VEED Fabric for talking avatars.
- Clarified that standalone asset requests use asset tools directly, while
  projects are used when the requested outcome needs an editable story,
  storyboard, production timeline, or final export.

### Fixed

- Preserved `--scene` and `--shot` scope across specialized edit and motion
  commands so completed media remains attached to the requested project shot.
- Aligned cost previews with runtime defaults, including Veo durations and
  reference-aware estimates.
- Restored documented exit code 2 for invalid CLI arguments and kept generated
  skill manifests and the exact-content skill index in sync.

## [0.3.8]

### Changed

- `videodraft credits` now shows your plan and monthly reset dates (last and
  next reset) alongside the balance, matching the richer balance snapshot the
  platform returns. JSON output already carried these fields; the
  human-readable table now displays them too.

## [0.3.7]

### Changed

- Audio pricing is now documented in the skill reference and cost tooling:
  voiceover TTS bills 10 credits per 1000 characters (30 per 1000 for cloned
  `custom-*` voices, min 1, pro-rated), Lyria music is a flat 10 credits
  (clip) / 15 credits (pro) per track, and voice cloning is a flat 150
  credits per clone. Silent tracks stay free, and BYOK keys (ElevenLabs/Fal)
  keep audio free on your own account.
- `videodraft costs` now quotes voiceover TTS: pass model id `voiceover`
  (or `voiceover-cloned` for cloned voices) with `--chars <n>` for an exact
  estimate; the `--chars` flag help text covers both uses.

## [0.3.6]

### Fixed

- Removed unsupported `argument-hint` and `allowed-tools` frontmatter from the
  packaged VideoDraft skill so stricter Codex skill loaders can discover it.

## [0.3.5]

### Changed

- Image model arguments now accept exposed display names as well as canonical
  model ids across generation, shot-image generation, visual assets, storyboard
  creation, and cost estimates.
- Cost estimates now treat Lyria music as a first-class audio model, including
  Fal BYOK zero-credit estimates when applicable.

## [0.3.2]

### Fixed

- Retry CLI requests with a newly-rotated profile PAT after a stale-token 401,
  so desktop-managed MCP key rotation can recover without restarting the CLI.

## [0.3.1]

### Fixed

- Synced the public CLI repo with the latest monorepo CLI source and npm line.
- Updated the schema-drift tool snapshot for the live MCP catalog, including
  `get_tool_catalog` and `list_cloned_voices`.
- Updated packaged CLI/agent help for Gemini Omni Flash, Nano Banana 2 Lite,
  Kling O3, and Wan 2.7 reference-video support.

## [0.3.0]

### Added

- Added `videodraft elevenlabs` commands for ElevenLabs BYOK status, set,
  enable, disable, remove, and cloned/professional voice listing.
- Added authenticated REST request support in the CLI client for non-MCP
  account routes such as `/api/elevenlabs-key`.
- Added bundled agent guidance for Nano Banana 2 Lite and Gemini Omni Flash.

## [0.2.1]

### Added

- `videodraft tools list` now uses the grouped VideoDraft tool catalog and
  supports `--lane` / `--category` filters, making asset generation, asset I/O,
  project data, and production tools easier for agents to discover.
- The bundled VideoDraft agent skill now leads with standalone asset generation
  and keeps projects reserved for scripts, storyboards, timelines, and exports.

### Fixed

- Fixed the typed options call in `tools list` so the CLI package compiles with
  the grouped catalog changes.

## [0.2.0]

### Added

- Added ElevenLabs audio commands: `generate sound-effect`, `generate dialogue`,
  `generate voice-changer`, and `generate dub`, with local media upload,
  JSON output, downloads, and AI Studio session/project linking.
- Added audio model discovery/cost guidance to the bundled VideoDraft agent
  skill so CLI users and agents can choose the right sound generation flow.

### Fixed

- **`--version` now reports the real version in the single-file (compiled)
  binary.** The version is baked in at build time via an esbuild `define`
  instead of being read from `package.json` at runtime — inside a compiled
  binary that read resolved a path in the embedded virtual filesystem and fell
  back to `0.0.0`. The `tsx` dev and `node dist/` paths still read
  `package.json` as before.

## [0.1.2]

### Added

- JSON output for media-producing commands now includes `output_media` descriptors
  with explicit `{ kind, url }` entries, so desktop and agent clients can render
  generated images, videos and audio without scraping human text or guessing from
  file extensions.

## [0.1.1]

### Fixed

- **Config writes are now serialized** under a lock with a re-read, so a
  concurrent process stamping `last_update_check` or a telemetry preference can
  no longer clobber freshly-rotated OAuth tokens (forced re-login).
- **`login` / `open` / `docs` no longer crash** on headless machines without a
  browser opener (e.g. `xdg-open` missing) — the printed URL fallback works.
- **Local uploads stream to GCS** instead of buffering — a few-hundred-MB
  `--ref-video` / `upscale video` clip no longer risks OOM.
- Node engine raised to **`>=20.18.1`** to match the `undici` dependency floor
  (advertised `>=20` could fail on 20.0–20.17).
- `logout` now targets the **active profile** (not literal `default`), so it
  can't leave the in-use credentials behind in a multi-profile setup.
- **Token refresh no longer clobbers a newer grant**: if a concurrent `login`
  replaced the profile mid-refresh, the rotation is skipped (the live token is
  kept) instead of restoring the old grant.
- File locks carry a **per-acquisition owner token** and only release the lock
  if it's still theirs — a holder that stalled past the stale window can't
  delete a lock another process has since acquired.
- **Telemetry can never fail a command**: `capture()` (and `anonymousId`'s
  persist) are fully best-effort, so a read-only config dir no longer turns a
  successful invocation into an error.
- **`/api/mcp` caps JSON-RPC batches at 50 items** so a single batch can't fan
  out unbounded concurrent work or smuggle many calls past the rate limit.

## [0.1.0]

First public release.

### Added

- Auth: `login` (browser OAuth, RFC 8252 loopback + PKCE) / `logout` / `whoami`;
  PAT and `VIDEODRAFT_API_KEY` for CI. Multi-process-safe OAuth refresh.
- Account: `credits`, `costs`, `models`, `workspaces`, `sessions list/create`.
- Projects: `projects list/get/delete/favorite/open`, `checkpoint create/list/restore`.
- Pipeline: `create`, `shots`, `produce` (`--mode full_video`), `attach`,
  `finalize`, `export`, `export-status`, `video-prompts`.
- Generate: `generate image/video/voiceover/music` (every model input surfaced —
  reference images/videos/audio, multi-prompt segments, video reference,
  rendering speed, prompt-optional for Kling 3.0 Turbo), `upscale image/video`,
  `avatar script/create/render/get/list`, `describe`.
- Jobs/media: `status`, `wait` (batched multi-job polling + adaptive backoff),
  `generations`, `upload`, `media list`, `download`.
- Full passthrough: `tools list/schema`, `call <tool>` — covers every MCP tool.
- Agent skill: `skills install` (auto-detects installed agents; `--agent`/`--all`),
  bundled and installable via `npx videodraft skills install` or
  `npx skills add videodraft-ai/cli`.
- Embeddable `videodraft/client` (Bun-compatible) for the desktop app sidecar.
- Agent ergonomics: `--json` everywhere, stable exit codes (0/1/2/3/4),
  `--no-wait`/`--wait`, `--download` templates, `NO_COLOR`, proxy support,
  opt-out telemetry, daily update notifier.
