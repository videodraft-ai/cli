# Changelog

All notable changes to the `videodraft` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## [Unreleased]

## [0.15.0] - 2026-08-24

### Added

- Connection sessions: the CLI now performs the MCP `initialize` handshake
  once per (profile, server, working directory), keeps the server's
  `Mcp-Session-Id`, and replays it on every call. Project-less generations
  from one directory are filed into their own AI Studio session (named after
  the client and date, e.g. "VideoDraft CLI · Aug 22, 2026") instead of the
  account-wide "Agent (MCP)" bucket. Sessions idle out after 12 hours.
- `videodraft sessions current` shows the directory's connection session
  (session id, web URL, expiry); `videodraft sessions reset [--all]` starts a
  fresh one. Two CLI processes racing in one directory converge on one
  session; the handshake negotiates MCP 2025-03-26 and completes the
  lifecycle (`notifications/initialized`, `MCP-Protocol-Version`).
- `--session <id>` on every generate/edit/avatar command and `generations`
  now also reads `VIDEODRAFT_SESSION` (the env default is ignored when
  `--project` is given, since project work uses the project's session); `VIDEODRAFT_SESSION_SCOPE=<label>` groups work across
  directories; `VIDEODRAFT_CLIENT_NAME=<host>` labels the auto session after
  the calling agent; `VIDEODRAFT_NO_SESSION=1` restores the stateless
  behaviour. An unverifiable cached session id is re-minted by the server and
  adopted automatically.
- `get_tool_catalog` replies now carry the full VideoDraft agent guidance for
  the requested lane (`guidance`), plus a `guidance_topics` index and a
  `guidance:"all"|"none"|<topic>` selector. The server's MCP `instructions`
  field is a short routing card (hosts truncate it at ~2 KB); the complete
  document is also the `videodraft://guidance` resource.

## [0.14.0] - 2026-08-19

### Added

- `videodraft produce --mode full_video --allow-real-people` now exposes the
  Seedance real-person routing choice in the curated hosted-production command.
- `videodraft costs --allow-real-people` now quotes the same Fal-tier price
  used by the generation and hosted-production opt-in.
- Seedance likeness refusals expose a stable
  `SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED` recovery contract with an exact
  one-retry flag for MCP and JSON-mode CLI callers.
- A partial `produce` run now says whether the one real-person retry was
  actually spent. A retry the server refused before charging or submitting
  anything reports `retry_preserved`, and `produce` tells you the attempt is
  still available instead of leaving you to assume it is gone.
- A submission whose response was lost reports `submission_unresolved`, and
  `produce` warns not to resubmit it: the job may be running and billed, and
  re-running `produce` reattaches it.

### Fixed

- Submit-time Seedance route errors no longer hide the actionable likeness
  message behind a generic failure, and async `status` / `wait` output keeps
  the same structured retry fields.
- A partially submitted hosted `full_video` run can be retried with real-person
  support without duplicating scene jobs. The retry resubmits failed
  placeholders only and preserves jobs that already started or completed.
- A hosted retry rejected for insufficient credits, or because the provider was
  unconfigured, no longer consumes the single real-person retry. Topping up and
  re-running the same command now works instead of reporting the attempt spent.
- A hosted retry whose submission was never acknowledged keeps its claim, so a
  later `produce` reattaches the generation to the timeline rather than
  stranding a job that was charged for.
- Video generations on Replicate-backed models (Seedance 1.5 Pro, Ray 2, Kling
  v2.1/v1.6, Wan 2.2/2.6, Runway Gen-4 Turbo) submitted with an MCP token are
  recorded again. They were failing to write their tracking row under bearer
  auth, which refunded the request while the provider kept running it and the
  finished video was discarded.
- A video submission whose provider response is lost is no longer reported as a
  failure. The generation id comes back so `status` / `wait` can resolve it,
  because the job may be running.

### Changed

- The bundled VideoDraft skill, model catalog, MCP instructions, and public
  CLI/MCP docs now explain the Byteplus-only default, tier-specific Fal
  pricing, proactive opt-in, one-retry limit, and late-failure refund behavior.
- Failure refunds for generations settle on a server-side ledger, so a dropped
  webhook, a retried callback, or a sweep running alongside one another can no
  longer refund the same generation twice or leave it unrefunded.

## [0.13.3] - 2026-08-18

### Fixed

- `--ref-video-seconds` was capped at 15 for every model, so a valid Seedance
  2.5 command (`--model seedance-2.5 --ref-video clip.mp4 --ref-video-seconds
  20 --estimate`) exited with a usage error before it was ever priced. Seedance
  2.5 accepts a 30-second combined reference window; 2.0 and Wan 2.7 accept 15.
  The flag now parses against the widest window and applies the exact limit
  once the model is resolved.
- Seedance 2.x and Wan 2.7 both bill reference-video seconds as INPUT seconds
  on top of the output duration, but `--estimate` only forwarded the value for
  Seedance. A Wan 2.7 reference estimate therefore quoted an output-only cost
  against a route charging `(input + output)`. Both models forward it now.

### Changed

- Bundled skill documents the reference-video window (30s on Seedance 2.5, 15s
  on Seedance 2.0 and Wan 2.7) and names Wan 2.7 alongside Seedance as a model
  that bills reference-video seconds.

## [0.13.2] - 2026-08-18

### Fixed

- Bundled skill still quoted MiniMax H3 at a flat **26 credits per output
  second** and claimed reference video costs 26 credits per input second, in
  both `SKILL.md` and `references/models.md`. 0.13.1 corrected the capability
  statements but not the pricing ones, so agents could still quote a cost up
  to 5x wrong and bill for reference video that is not charged. H3 is
  5 / 6 / 13 / 16 cr/s at 480p / 768p / 2K / 4K, and reference video and audio
  are not billed.
- `--ref-video-seconds` only ever reached MiniMax H3 estimates, which no
  longer bill reference video, so the flag was a no-op while its help text
  claimed otherwise. It now also feeds Seedance 2.x, which genuinely bills
  input seconds alongside output — those `--estimate` quotes were short by the
  whole reference duration.

## [0.13.1] - 2026-08-18

### Fixed

- Bundled skill contradicted itself and the shipped capabilities in three
  places, all of which went out in 0.13.0: it told agents Seedance 2.5 "has no
  1080p or 4K" (it has 1080p, and three other lines in the same file said so),
  and described MiniMax H3 as "fixed 2K" twice after it gained the
  480p/768p/2K/4K ladder. Agents reading those lines would refuse or misprice
  supported requests. The skill only reaches agents through a publish, so a
  release is the only way to correct it.

## [0.13.0] - 2026-08-18

### Added

- `videodraft generate video --allow-real-people` for Seedance 2.0 / 2.5.
  Without it a job runs on Byteplus alone, which refuses real-person
  likenesses and fails with a content-filter error rather than silently
  falling back. With it the Fal fallback is permitted and the job is priced at
  Fal's rate for that tier. Threaded through both the submit and `--estimate`
  paths.
- New image model `grok-imagine-2.0` (xAI Grok Imagine 2.0), alongside the
  existing `grok-imagine`, which is unchanged. Adds `--resolution 1K|2K` and
  `--quality low|medium`: 1K 4/6 cr, 2K 6/8 cr, plus 1 cr per reference image
  (up to 3 on edit), and 13 aspect ratios including 20:9 and 9:20.
- `seedance-2.5` accepts `--resolution 1080p` (57 cr/s, 114 with
  `--allow-real-people`). The provider added the tier on 2026-08-17.
- `minimax-h3` accepts `--resolution 480p|768p|2K|4K`. It was pinned to 2K.

### Changed

- **Seedance 2.x rates re-derived from each provider's published per-token
  rate.** Byteplus-routed jobs are priced at Byteplus cost and the
  `--allow-real-people` path at Fal cost, as a per-tier lookup rather than a
  flat 2x — Fal is about 2x on most tiers but 1.82x at both 1080p rows.
  Current per-second rates, Byteplus / Fal:

  | tier | 480p | 720p | 1080p | 4K |
  | --- | --- | --- | --- | --- |
  | 2.0 Mini | 4 / 8 | 8 / 16 | – | – |
  | 2.0 Fast | 6 / 11 | 13 / 25 | – | – |
  | 2.0 Standard | 7 / 14 | 16 / 31 | 38 / 69 | 78 / 156 |
  | 2.5 | 11 / 23 | 24 / 48 | 57 / 114 | – |

  Rates are pegged to Byteplus LIST prices, deliberately NOT to its
  limited-time promos (2.5 1080p is 28% off through 2026-09-17; 2.0 Mini and
  Fast through 2026-09-07), because pricing against a promo goes underwater
  the day it expires.
- **MiniMax H3 is priced at exact Fal cost and is no longer 2K-only:** 5 / 6 /
  13 / 16 cr/s at 480p / 768p / 2K / 4K, against a previous flat 26 (exactly
  2x cost). The first 5 reference images stay free with 8 credits each after,
  matching Fal. Reference VIDEO seconds are no longer charged at all, because
  Fal does not bill them.
- Wan 2.7 is resolution-aware (10 cr/s at 720p, 15 at 1080p) and
  reference-to-video now bills input video seconds alongside output, matching
  how Fal charges, capped at 3 reference videos and 15 combined seconds.
- Seedance reference-video pricing multiplier is per version: `seedance-2`
  uses 0.62 and `seedance-2.5` 0.60. A flat 0.60 (taken from Fal) left 2.0
  Standard 1080p and 4K reference-video jobs under cost.

### Fixed

- `generate image --estimate` counts `--ref` images for `grok-imagine-2.0`,
  which bills 1 credit per reference on top of the resolution x quality
  matrix. Two 2K-medium outputs with three references were quoted 16 credits
  and 22 were deducted.
- Bundled skill guidance no longer tells agents that Seedance 2.5 is
  480p/720p-only or that MiniMax H3 is fixed at 2K, so they stop refusing
  supported requests.

## [0.12.0]

### Added

- Added `videodraft kling-voices list/create/delete` for creating and managing
  Kling video-control voices. Local MP3, WAV, MP4, and MOV samples upload
  automatically; creation supports a no-write cost estimate and requires an
  explicit consent confirmation.
- Added repeatable structured `--element` inputs for Kling 3.0 and Kling O3.
  Elements may use a frontal image with 1-3 references or one reference video,
  and either source form can keep its own `voice_id`. Nested local media uploads
  automatically before generation.
- Added repeatable `--voice-id` inputs for Kling 2.6 Pro, including validation
  for the matching `<<<voice_1>>>` and `<<<voice_2>>>` prompt markers.
- Added optional image-backed elements to Kling V3 motion control.

### Changed

- Kling generation estimates now use the dedicated known voice-control rates
  for Kling 2.6 Pro and Kling 3.0 Standard/Pro.
- Model inference and validation now reject unsupported Kling Turbo elements,
  mixed image/video element sources, invalid reference counts, missing audio,
  and malformed or unreferenced voice IDs before submission.
- The bundled VideoDraft skill now documents Kling voice creation, elements,
  voice binding, prompt markers, local upload behavior, and current pricing.

## [0.11.0]

### Added

- AI Studio generation history is now queryable from the CLI. `videodraft
generations` gains `--session <id>` and `--project <id>` scoping (shared
  scopes include collaborators' generations), `--model` and `--favorites`
  filters, `--offset` pagination, `--full` (pair with `--json`) for each
  row's exact generation parameters, and a favorite (★) column.
- New `videodraft generation <id>` prints one generation's complete recipe —
  prompt, model, input image, parameters, and output URLs — and stars or
  unstars it with `--favorite` / `--unfavorite`.
- `videodraft sessions list` now shows shared sessions you are a member of
  (with role and image/video/sound counts) and gains `--name` search,
  `--limit`, and `--offset`.
- The bundled `videodraft` skill gains a "Generation history" section so
  agents reuse a previous generation's exact settings instead of guessing.

### Changed

- `videodraft generation <id>` output URLs are normalized from legacy rows
  that store structured objects instead of plain URL strings.

### Notes

- The history commands need the VideoDraft API's generation-history tools
  (rolling out mid-August 2026). Against an older server, `generation` and
  the new `generations` filters report the tool or argument as unknown or
  are ignored; everything else is unaffected.

## [0.10.0]

### Added

- Added ByteDance Seedance 2.5 (`--model seedance-2.5`) to video generation,
  model selection, and cost estimates: 4-30 second clips at 480p (23 cr/s) or
  720p (48 cr/s) with native audio, from a prompt, a first frame, first + last
  frames, or up to 50 references (30 image, 10 video, 10 audio). Seedance 2.0
  is unchanged; 2.5 has a single quality tier and no 1080p/4K.
- Automatic model selection now picks `seedance-2.5` when the requested clip
  runs past 15 seconds or carries more references than Seedance 2.0 accepts
  (more than 9 image, 3 video, or 3 audio). Clips of exactly 15 seconds or
  fewer keep routing to Seedance 2.0.

### Changed

- The bundled `videodraft` skill now covers Seedance 2.5 model selection, its
  4-30s range, and its expanded reference budget. Agents only pick up skill
  changes through a published release, so this is the release that ships it.
- `--ref-video` / `--ref-audio` help text now names Seedance 2.5 alongside the
  other reference-capable models.

## [0.9.0]

### Added

- Added Black Forest Labs FLUX 3 to video generation, model selection, and cost
  estimates: 5-20 second clips at 720p (17 cr/s) or 1080p (29 cr/s) with native
  audio, from a prompt, a first frame, first + last frames, or keyframes.
- Added `--keyframe <url|file@seconds>` to `generate video` (repeatable, up to 10) for FLUX 3 keyframes mode, which pins images to exact moments in the
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
