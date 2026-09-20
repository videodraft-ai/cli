# videodraft

The official [VideoDraft](https://videodraft.ai) CLI creates AI videos, images, audio and 3D assets from your terminal. Built for humans **and** coding agents: every command supports `--json`, exit codes are stable, async jobs are first-class.

```bash
npx videodraft login
npx videodraft generate image "a red fox in snow, cinematic" --download ./out/
npx videodraft create "30s launch video for our espresso machine" --ar 9:16
```

## Install

```bash
npm install -g videodraft     # global: adds the `videodraft` command to your PATH
videodraft --version          # → confirms it's installed

# …or run without installing — npx fetches and runs the latest each time:
npx videodraft <command>
```

Requires Node ≥ 20.18.1. (Publishing to npm doesn't put `videodraft` on your PATH — `npm i -g` or `npx` does. A Homebrew tap and a `curl | sh` installer are on the way.)

## Authenticate

```bash
videodraft login                    # opens your browser (OAuth)
videodraft login --token vd_mcp_…   # personal access token from https://app.videodraft.ai/mcp-keys
export VIDEODRAFT_API_KEY=vd_mcp_…  # headless / CI — no login command needed
```

Credentials are stored in `~/.config/videodraft/config.json` (0600). `videodraft logout` revokes and clears them.

## Asset generation first

Standalone images, clips, audio and 3D models are complete deliverables. They do not need a VideoDraft project unless you want to attach them to an existing project or turn them into a multi-scene production.

```bash
videodraft generate image "isometric workspace, warm light" --num 4 --download "./out/{job_id}_{index}.{ext}"
videodraft generate video "slow dolly over a misty lake" --model google-veo3.1 --duration 6 --estimate
videodraft generate video "A cyclist races through rain at night" --model minimax-h3-max --duration 8 --resolution 768p --prompt-expansion-mode balanced
videodraft generate video "Image 1 is the rider. Video 1 sets the camera move." --model minimax-h3-max --duration 8 --ar adaptive --ref rider.png --ref-video camera.mp4
videodraft generate video "Keep the product and match these camera moves" --model gemini-omni-1.1-flash --duration 8 --resolution 1080p --video-task generate --ref ./product.png --ref-video ./move-1.mp4 --ref-video ./move-2.mp4
videodraft generate video "Keep the subject and use this camera language" --model gemini-omni-1.1-flash --source-video ./source.mp4 --ref-video ./camera-ref.mp4 --ref-video-duration 2.5 --video-task edit --resolution 1080p
videodraft generate video "The scene continues as the camera follows her outside" --model gemini-omni-1.1-flash --source-video ./source.mp4 --extend --duration 8 --resolution 720p --download ./extended.mp4
videodraft generate video --model gemini-omni-1.1-flash --previous-interaction-id INTERACTION_ID --ref-video ./new-motion-ref.mp4 --ref-video-duration 3 --resolution 4K --download ./edited-turn.mp4 # conversational edit; add --extend to lengthen
videodraft generate audio "Read this in a calm documentary voice" --voice vivi_mixed_en_zh_ja_es_id --download narration.mp3
videodraft generate audio "Extend @Audio1 with soft rain" --ref-audio ./opening.wav --download extended.wav --format wav
videodraft generate voiceover "Welcome to VideoDraft" --download welcome.mp3
videodraft generate music "minimal ambient, 60 BPM" --download bgm.mp3
videodraft generate sound-effect "cinematic whoosh, sub hit" --duration 3 --download sfx.mp3
videodraft generate dialogue --line "elevenlabs-kPzsL2i3teMYv0FxEYQ6:Ready?" --line "elevenlabs-s3TPKV1kjDlVtZbl4Ksh:Let's go." --download dialogue.mp3
videodraft generate voice-changer ./speech.wav --voice elevenlabs-kPzsL2i3teMYv0FxEYQ6 --duration 12 --download changed.mp3
videodraft generate dub ./clip.mp4 --to es --duration 30 --download dubbed.mp4
videodraft upscale image ./photo.png --scale 4x --download ./photo-4x.png
videodraft upscale video ./clip.mp4 --resolution 1080p --mode generative --download ./clip-1080p.mp4
videodraft interpolate ./clip.mp4 --fps 60 --download ./clip-60fps.mp4
videodraft avatar create ./founder.jpg --script "$(videodraft avatar script 'our launch' --json | jq -r .script)"
videodraft edit video ./clip.mp4 "Add falling snow" --model grok-imagine-video-edit --download ./clip-snow.mp4
videodraft edit motion ./character.png "Apply the reference dance" --motion-video ./dance.mp4 --download ./character-dance.mp4
videodraft generate video "Match this performance" --model kling-o3-video-ref-edit --ref-video ./performance.mp4 --ref ./wardrobe.png --download ./guided.mp4
videodraft kling-voices create ./speaker.wav --name "Narrator" --confirm-consent
videodraft kling-voices create ./speaker.wav --name "Narrator" --estimate
videodraft generate video "@Element1 says welcome" --model kling-3.0 --start-image ./scene.png --audio --element '{"video_url":"./speaker.mp4","voice_id":"VOICE_ID"}'
videodraft generate video "<<<voice_1>>> Welcome" --model kling-2.6-pro --start-image ./host.png --audio --voice-id VOICE_ID
```

`generate audio` automatically retries transient and lost responses with one
stable operation key. To recover after stopping or losing the CLI process, set
your own UUID up front and reuse it if needed:

```bash
videodraft generate audio "..." --idempotency-key "$(uuidgen)"
```

The server then returns the existing result or in-progress operation without
generating or charging twice.

Discover the full asset lane:

```bash
videodraft tools list
videodraft tools list --lane assets
videodraft tools list --lane asset_io
videodraft models image
videodraft models video
videodraft models video --category video_edit
videodraft models audio
```

Asset I/O is part of the asset workflow: `videodraft upload`, `videodraft download`, generation `--download`, and local refs like `--ref ./image.png` make files usable by agents and visible in local workspaces.

### 3D model generation and rigging

Meshy 7 and Tripo H3.1 support text, image, and multi-image inputs through Fal. Saved 3D assets are independent of AI Studio sessions. Inspect the live catalog for each endpoint's exact options, view order, limits, default settings, output formats, and pricing:

```bash
videodraft models 3d --json
videodraft generate 3d "a weathered brass telescope" --model meshy-7 --estimate
videodraft generate 3d --model meshy-7 --ref ./character.png --download
videodraft generate 3d --model tripo-h3.1 --input-mode multi_image --ref ./front.png --ref ./left.png --ref ./back.png --ref ./right.png --options @model-options.json --no-wait --json
videodraft wait JOB_ID --download ./media/3d --json
videodraft assets 3d list --status completed --json
videodraft assets 3d get ASSET_ID --download
videodraft rig 3d --asset ASSET_ID --estimate
videodraft rig 3d ./character.glb --download
```

The positional prompt is for text mode. Image modes do not accept a geometry prompt; Meshy has a separate `texture_prompt` option for texture guidance. `--input-mode` defaults to text without references, image with one reference, and multi-image with two or more. Meshy multi-image accepts 1-4 views; use explicit `--input-mode multi_image` for a single view. Tripo accepts 2-4 views in front, left, back, right order. Rigging accepts a compatible textured humanoid GLB as a saved asset, public URL, or local file. It does not promise a facial/dialogue rig. Local GLBs use the separate 3D upload lane.

`--options '{...}'` or `--options @file.json` passes exact provider fields. Repeat `--option key=value` to override individual fields; values preserve JSON objects, arrays, numbers, and booleans. Read the live schemas instead of assuming both models share option names. `--estimate` uses the same server pricing calculation as submission and does not upload local inputs. Charges are whole VideoDraft credits at 100 credits per dollar. Fal BYOK uses your connected Fal account and zero VideoDraft credits.

3D `--download` saves **all returned model files, textures, materials, animations, and previews**, plus `manifest.json`, under `media/3d/<asset_id>/`. A custom directory receives a per-asset subdirectory; `{job_id}` or `{asset_id}` can specify the directory layout. A single `.glb` filename or image/video `{index}.{ext}` template is rejected because it would discard the rest of the package. Existing downloads are preserved by adding a directory suffix. GLB/FBX/ZIP bytes are retained; glTF/OBJ/MTL dependency links are adjusted to their downloaded filenames. Provider-supplied dependency aliases restore texture paths required by original FBX files. Inspect `package_warnings` and the manifest's `complete` field before treating packages as self-contained. A failed download leaves no completed manifest.

Each submission includes a UUID `request_id`. Retry interrupted submissions with the **same arguments and `--request-id UUID`**. A local request journal in the CLI config directory reuses the originally uploaded references. Reusing a UUID with changed inputs fails. The journal contains the submitted prompt/options and public asset URLs and is stored with owner-only permissions. If a wait times out, use `status` or `wait` with the existing job ID; do not submit a new request.

Machine output preserves `artifacts` and adds `output_files`, `downloaded_files`, `manifest_path`, and `package_warnings`. Only rendered previews appear in `output_media`; meshes and texture maps never masquerade as playable images or videos. Use external 3D software to view/edit the meshes. This release does not add an AI Studio 3D viewer.

## The project pipeline

Use projects when the user asks for a story, storyboard, editable web project, timeline, production flow, or exported MP4.

```bash
videodraft credits                              # know your budget
videodraft create "<idea>" --ar 9:16            # idea → script → visual assets → storyboard
videodraft shots <project> --grid --estimate    # preview the cost…
videodraft shots <project> --grid               # …then batch-generate every shot image
videodraft produce <project>                    # voiceovers + captions + production timeline
videodraft produce <project> --mode full_video   # one Seedance video per scene
videodraft export <project> --download final.mp4
```

Seedance 2.x allows real people by default, the same as AI Studio: Byteplus
first, a submit-time Fal fallback, and Fal's higher tier-specific rate. Pass
`--no-allow-real-people` for the lower Byteplus-only rate when nothing in the
job is a real identifiable person. If an opted-out request returns
`SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED`, estimate the higher rate and retry once
with `--allow-real-people`. Do not loop if real people were already allowed;
late Byteplus output refusals are refunded but cannot be rerouted.

## Commands

| Group           | Commands                                                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth            | `login` `logout` `whoami`                                                                                                                                                                                                 |
| Account         | `credits` `costs [model]` `models [image\|video\|audio\|voices\|styles]` `workspaces` `sessions list/create/current/name/reset` `kling-voices list/create/delete`                                                         |
| Projects        | `projects list/get/delete/favorite/open` `checkpoint create/list/restore`                                                                                                                                                 |
| Pipeline        | `create` `shots` `produce` (`--mode full_video`) `attach` `finalize` `export` `export-status` `video-prompts`                                                                                                             |
| Generate        | `generate image/video/audio/voiceover/music/sound-effect/dialogue/voice-changer/dub/3d` `rig 3d` `edit video/motion` `upscale image/video` `interpolate` `avatar script/create/render/get/list/fabric/lipsync/h3-lipsync` |
| 3D assets       | `models 3d` `assets 3d list` `assets 3d get <id> --download`                                                                                                                                                              |
| Jobs            | `status <job>` `wait <job>` `generations`                                                                                                                                                                                 |
| Media           | `upload <file>` `media list` `describe <url\|file>` `download <url>`                                                                                                                                                      |
| Stock media     | `stock search "<query>"` `stock import <ref>` (free, no credits)                                                                                                                                                          |
| Everything else | `tools list [--lane assets\|asset_io\|project_data\|production]` `tools schema <name>` `call <tool> --args '<json>'`                                                                                                      |
| Agents          | `skills install [--agent claude\|codex\|cursor]` `skills path`                                                                                                                                                            |
| Utility         | `config get/set/path` `completion bash\|zsh` `docs` `--version`                                                                                                                                                           |

`call` reaches **every** VideoDraft API tool (the full MCP catalog), including ones without a curated command — new platform features work in the CLI the day they ship.

Kling voice creation costs 1 VideoDraft credit on the platform Fal account and
0 credits with Fal BYOK. `--estimate` checks the active account without creating
a voice. Samples must be MP3, WAV, MP4, or MOV, 5-30 seconds, and no larger
than 50 MB. Voice IDs are opaque strings scoped to the Fal account that created
them; keep a `voice_id` inside its image-backed or video-backed element so the binding is preserved.

## For agents and scripts

- `--json` on any command prints a single JSON document on stdout.
- Exit codes: `0` ok · `1` error · `2` usage · `3` auth required · `4` insufficient credits.
- Async generations wait by default; `--no-wait` returns `{job_id}` immediately, `videodraft wait <job...>` resumes, `--wait-timeout 30m --wait-interval 5s` tune polling.
- **Many jobs at once?** Submit them all with `--no-wait`, then `videodraft wait <id1> <id2> ...` — one process polls every job with ONE batched request per tick (don't spawn N parallel `wait` processes). Polling backs off adaptively (3s → 15s with jitter) on long jobs unless you pin `--wait-interval`.
- `--download` templates: `{job_id}`, `{index}`, `{ext}`, `{name}`. Downloads are echoed as `downloaded_files[]` in `--json` output.
- Local file → public URL anywhere a URL is expected (`--ref photo.jpg`), or explicitly via `videodraft upload`.
- `NO_COLOR` and `--no-color` are respected; output is uncolored when piped.

Install the VideoDraft skill so your agent knows the workflow:

```bash
npx videodraft skills install                  # zero-install: npx fetches the CLI and installs the skill
videodraft skills install                      # if the CLI is on PATH — auto-detects your installed agents
videodraft skills install --agent claude,codex # target specific agents (repeatable/comma; --all for every agent)
videodraft skills install --project            # into ./.claude/skills for just this repo (else global)
videodraft skills show                         # print the skill (also: skills show editor|models|3d|examples|pipeline|--all)

# Or install straight from the repo — no CLI on PATH needed first:
npx -y skills add videodraft-ai/cli -g         # vercel-labs skills tool; npx -y skips npx's install prompt; -g = user scope
gh skill install videodraft-ai/cli videodraft --scope user   # GitHub CLI; name the skill + user scope (else it lists / installs project-scoped)
# Claude Code:  /plugin marketplace add videodraft-ai/cli   then  /plugin install videodraft@videodraft
# Codex:        codex plugin marketplace add videodraft-ai/cli   then  codex plugin add videodraft@videodraft
```

## Environment variables

| Variable                                  | Purpose                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `VIDEODRAFT_API_KEY`                      | Bearer token (`vd_mcp_…`) — skips the login flow    |
| `VIDEODRAFT_BASE_URL`                     | Target server (default `https://app.videodraft.ai`) |
| `VIDEODRAFT_CONFIG_DIR`                   | Config location (default `~/.config/videodraft`)    |
| `VIDEODRAFT_TELEMETRY=0`                  | Disable telemetry                                   |
| `DO_NOT_TRACK=1`                          | Disable telemetry (and the update check)            |
| `VIDEODRAFT_NO_UPDATE_CHECK=1`            | Disable the update notice                           |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Proxy support                                       |

## Telemetry

The CLI sends anonymous usage events (command name, CLI version, OS, duration, success/error class — **never prompts, file contents, or arguments**) to help us improve it. Opt out any time:

```bash
videodraft config set telemetry false   # or VIDEODRAFT_TELEMETRY=0 / DO_NOT_TRACK=1
```

## Embedding (`videodraft/client`)

The CLI's core is exported for programmatic use (Node ≥ 20 and Bun):

```ts
import { VideoDraftClient, resolveAuth } from "videodraft/client";

const { tokenProvider, baseUrl } = resolveAuth({}); // flag/env/config-store resolution
const client = new VideoDraftClient({ tokenProvider, baseUrl });
const me = await client.callTool("whoami");
```

## License

MIT © VideoDraft
