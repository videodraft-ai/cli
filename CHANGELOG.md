# Changelog

All notable changes to the `videodraft` CLI. Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

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
