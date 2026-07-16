---
name: videodraft
description: Create AI videos, images, Seed Audio, voiceovers, music, sound effects, dialogue, dubbing, storyboards, avatar videos, media upscales and product/ad videos with VideoDraft. Use when the user mentions VideoDraft, or asks to generate/make a video, video ad, explainer, storyboard, talking-head/avatar video, AI image, prompt-driven or reference-driven audio, voiceover/TTS, background music, sound effects, dialogue audio, voice changing, dubbing, or image/video enhancement and upscaling, including batch/programmatic video generation in scripts or CI. Works via the `videodraft` CLI (preferred in terminals) or the VideoDraft MCP connector.
---

# VideoDraft

VideoDraft is an AI video creation platform where asset generation is the priority lane:

- **Asset generation**: standalone images, video clips, Seed Audio, voiceovers, music, sound effects, dialogue, voice-changed audio, dubbed media, upscales, and image descriptions. This is the fastest and most important lane. Treat these as complete deliverables when the user asks for assets.
- **Asset I/O**: upload local files, download outputs, auto-upload local references, and save generated media where the user can see it.
- **Project production**: idea → script → storyboard (scenes + shot images) → project data → production timeline → exported MP4. Use it for a multi-scene video, story, ad, explainer, storyboard, editable timeline, or final export, even when the user does not say "project." A script-only request also creates a script-stage project but stops at the script.

## How to connect

Two equivalent surfaces (same backend, same credits, same projects):

1. **CLI** (preferred when you have a shell): run `videodraft` if it's on PATH; otherwise `npx -y videodraft@latest` runs it with no install (needs Node ≥20; the `-y` skips npx's install prompt so it runs non-interactively; the package is fetched on first use and cached). For heavy use, `npm install -g videodraft`. If there's no Node/shell here but the MCP connector below is available, use that instead; if neither works, tell the user how to install (https://videodraft.ai/cli).
   - Auth — pick by context, don't guess:
     • INTERACTIVE (a human is in the session, e.g. Claude Code / Codex): on exit code 3 ("not authenticated"), tell the user to run `videodraft login` in their terminal — it opens their browser for a one-click VideoDraft sign-in (OAuth), no key to copy. Wait for them to confirm it succeeded, then retry the command. This is the preferred path when the user is present.
     • HEADLESS / CI (no browser): set `VIDEODRAFT_API_KEY=vd_mcp_...` (a token the user mints at https://app.videodraft.ai/mcp-keys).
     • SECURITY: never ask the user to paste a `vd_mcp_...` token into the chat — use browser `login` or the env var so the token never lands in the transcript.
   - Every command accepts `--json` (parse this, don't scrape text). Exit codes: 0 ok, 1 error, 2 usage, 3 auth (see Auth above), 4 insufficient credits (→ tell the user, don't retry).
   - Tool discovery: start with `videodraft tools list` for the grouped catalog, then narrow with `videodraft tools list --lane assets`, `--lane asset_io`, `--lane project_data`, or `--lane production`.
   - Asset lane: `videodraft generate ...`, `videodraft edit video|motion`, `videodraft avatar ...`, `videodraft upscale ...`, `videodraft upload`, and `videodraft download`.
   - Full API access: `videodraft tools schema <name>`, `videodraft call <tool> --args '<json>'`.
2. **MCP connector**: if VideoDraft MCP tools (e.g. `generate_storyboard_from_idea`) are available, call them directly — the CLI's curated commands map 1:1 onto these tools.

## First decision: asset or project?

- **One standalone asset** (image, clip, voiceover, music track, sound effect, dialogue track, voice-changed file, dubbed media file, upscale, or description): generate it directly. Do NOT create a project.
  - `videodraft generate image "a red fox in snow, cinematic" --ar 16:9 --download ./out/`
  - `videodraft generate video "slow dolly over a misty lake" --model gemini-omni-flash --duration 6 --download ./out/`
- **A small set of related assets**: still stay in the asset lane. Use an AI Studio session if you need to group related generations. Switch to a project only when the deliverable matches the project criteria below or the user asks to attach the assets to one.
- **A multi-scene video / ad / explainer, storyboard, timeline, or final exported video**: create a project so the work stays organized, editable in the web app, and exportable.
  - `videodraft create "30s launch video for our espresso machine" --ar 9:16`
- **Just a script** (no video asked for): `videodraft create "..." --script-only`. Stop at the script — do not build a storyboard the user didn't ask for.
- **Iterating on existing work**: find it first (`videodraft projects list`) and reuse that project. Never create a new project to change an existing one.

## Choose the model from the task

If the user names a model, use it when compatible. If it cannot handle the request, explain why and recommend alternatives instead of silently switching. Otherwise inspect the inputs, duration, audio, quality, speed, and cost, check the live catalog, and pass an explicit model.

**Images:**

- `nano-banana-2`: general default, editing, consistency, and references.
- `nano-banana-pro`: maximum quality. `nano-banana-2-lite`: fast, inexpensive drafts.
- `gpt-image-2`: posters, logos, signs, title cards, readable text, or precise composition/editing.

**Videos:**

- `gemini-omni-flash`: general default up to 10s, first frame/image references, or editing one source video without extra media references. Fixed 720p with audio.
- `seedance-2`: 11-15s, video/audio/mixed references, wider ratios, selectable audio, or first/last frames. Use `mini` for cost, `fast` for speed, `standard` for quality or 1080p/4K.
- `kling-v3-turbo`: fast polished 3-15s with first frame, multi-prompt, and audio. `kling-o3`: image references, first/last frames, multi-prompt, audio control, or 4K. `kling-3.0`: similar without reference-image mode.
- Existing-video edits use `videodraft edit video`, not generic generation. Choose from the `video_edit` catalog category: Grok for simple prompt edits, Wan 2.7 for one style reference or source-matching duration, Happy Horse for up to 5 references, and Kling O3 for controlled reference-image edits.
- Kling O3 and Wan 2.7 Ref/Edit also have reference-generation modes. Use `videodraft generate video --model <ref-edit-id>` with `--ref-video`/`--ref` to generate a new guided clip; use `videodraft edit video` when changing the source itself.
- Motion transfer uses `videodraft edit motion` with Kling V3 by default, or Kling 2.6 when explicitly requested or lower cost matters. It requires a subject image and a motion-reference video.
- Use Veo 3.1 when explicitly requested or as a fallback.

**Audio and utilities:**

- Use Seed Audio 1.0 for open-ended text-to-audio, speech/music/sound synthesis, voice conditioning, or prompt-driven editing with up to three audio references or one image. Use `videodraft generate audio`. Reference clips are `@Audio1`, `@Audio2`, and `@Audio3` in array order. There is no duration input. Output is up to two minutes and settles at 19 credits per actual minute, with up to 38 credits reserved during generation. The CLI automatically retries transient responses with one operation key. To recover after the CLI process itself is interrupted, set `--idempotency-key <uuid>` on the original command and reuse it.
- Prefer ElevenLabs for voiceover, dialogue, voice changing, dubbing, and sound effects. Honor an explicitly selected supported TTS voice/provider. Use Lyria for instrumental music and ElevenLabs Music for vocals, lyrics, or exact timing.
- Talking head/presenter: choose by source. Use managed `avatar create` then `avatar render` when the user wants a reusable avatar record and bundled speech. Use `avatar fabric` for a one-off portrait plus text or existing audio. Use `avatar lipsync` when both the source video and replacement audio already exist.
- Enhancement: use Topaz image/video upscaling only when the content is already correct. Use image 1x for cleanup, 2x by default, 4x when justified; use video 2x by default. Edit or regenerate creative errors.

See [references/models.md](references/models.md) for the detailed routing table and exact capability limits.

## Prefer references when continuity matters

Pure text-to-image or text-to-video is fine for a generic one-off asset. When a specific character, product, location, style, composition, or brand identity must survive generation, use references instead of hoping the prompt recreates it.

- If the user supplies reference media, preserve and pass it. Never reduce the request to text alone.
- When continuity matters, generate/select a strong still first with the selected image model (`nano-banana-2` by default), wait for its URL, then animate it as a start frame/reference. Confirm the combined image and video cost.
- For multiple shots, use `videodraft shots <project_id> --model <selected-image-model> --grid`, then animate the decoded shots. Preserve explicit models. A requested non-Seedance video model must use manual per-shot generation instead of Seedance full-video mode.

## Cost and credits

Do not call `videodraft credits` before routine generations. Paid endpoints validate and deduct atomically; if the balance is insufficient, the request is rejected before the provider job starts (CLI exit code 4). Check the balance only when the user asks, gives a credit budget, or a large workflow needs budget planning.

For expensive work, estimate with `--estimate` or `videodraft costs`, state the selected model/settings/cost, and get a go-ahead. This matters most for shot-image batches, long or high-resolution video, AI Production, and paid audio batches. Honor the user's confirmation preference for the session.

`videodraft models image|video` lists the live image and video catalogs with supported inputs. Video entries are grouped as `generation`, `video_edit`, `motion_control`, `avatar_lipsync`, and `upscale`, and each reports the exact tool. Use `videodraft models video --category video_edit` to narrow the list. `videodraft models audio` lists Seed Audio, Google Lyria, and ElevenLabs audio/media tools, while `videodraft models voices` lists TTS voices. Consult them instead of guessing capabilities.

## Async jobs

Image/video generation is asynchronous: commands submit a job and **wait by default**, printing output URLs (and saving files with `--download`). In scripts/CI prefer explicit control:

```bash
JOB=$(videodraft generate image "..." --no-wait --json | jq -r .job_id)
videodraft wait "$JOB" --download "./outputs/{job_id}_{index}.{ext}" --json
```

For MANY jobs: submit each with `--no-wait`, collect ALL with one command — `videodraft wait <id1> <id2> ...` polls every job from one process with one batched request per tick. Do NOT spawn parallel `wait`/`generate --wait` processes for a batch.

If a wait times out, the job is still running server-side — `videodraft status <job_id>` later. Never re-submit just because a wait timed out (that double-spends credits).

## Local files and reference images

Reference inputs must be public URLs. The CLI uploads local files automatically wherever a URL is expected (`--ref photo.jpg`, `--start-image frame.png`), or explicitly:

```bash
URL=$(videodraft upload ./product.png --json | jq -r .url)
```

Never silently drop a reference you couldn't upload — stop and tell the user. Never upload a user's file to a third-party host.

When the user attaches media, classify each item before acting: a recurring **visual asset** (character/product/location/style), actual **footage to place as shots**, or **inspiration only**. See [references/pipeline.md](references/pipeline.md) for how each role flows into a project.

## Showing media to the user

Generated media is **not** displayed in the chat automatically — you decide what to show. To preview an asset inline, save it locally (use `--download` so it lands under `media/`) and reference its **local path** as a Markdown link with a **leading `./`**:

```
[ferrari shot](./media/ferrari_01.png)     ← image card
[the clip](./media/clip.mp4)               ← video player
[voiceover](./media/vo.mp3)                ← audio player
```

Put the Markdown link **in your message text** — video and audio embed exactly like images. Do **not** use `SendUserFile` (or other file-send tools) to display media: that renders inside a collapsible tool card and gets buried in the tool list. The Markdown link in your prose is what produces the inline card.

Use the path you saved to: a **workspace-relative** path (`./media/clip.mp4`, or `./<any-folder>/clip.mp4` — any folder in the workspace works), or the **absolute** path for a file outside the workspace (e.g. `/Users/you/Desktop/clip.mp4` or another workspace's path). Both render. Show the finished results worth showing (and only those — not every intermediate job). A bare CDN URL or a JSON dump of output URLs does **not** render; the local-path Markdown link is what produces an inline card.

## The full pipeline (idea → MP4)

```bash
videodraft create "<idea>" --ar 9:16            # project: script → visual assets → storyboard
videodraft shots <project_id> --grid --estimate # cost preview, confirm with user
videodraft shots <project_id> --grid            # batch shot images (waits, writes onto shot cards)
videodraft produce <project_id>                 # voiceovers + captions + production timeline
videodraft export <project_id> --download final.mp4
```

Optional between produce and export: per-shot motion clips (`videodraft generate video ... --project <id>` then place it with `videodraft attach <project> --scene N --shot M --media <url|file> --type video --duration <s>`), music (`videodraft generate music "..." --attach <project_id>`), and standalone audio assets (`generate audio`, `generate sound-effect`, `generate dialogue`, `generate voice-changer`, `generate dub`). Details, per-step tools and editing rules: [references/pipeline.md](references/pipeline.md).

Avatar/talking-head videos use dedicated commands. For a reusable managed avatar, obtain or generate a clear portrait → `videodraft avatar script` when needed → `videodraft avatar create` → `videodraft avatar render --resolution 720p`. For a one-off portrait, use `videodraft avatar fabric <portrait> --text "..."` or `--audio <file>`. For an existing video plus replacement audio, use `videodraft avatar lipsync <video> --audio <file>`. Managed script/creation is bundled/free; direct Fabric, Sync, the managed Fabric render, and optional portrait generation/upscaling are paid. Confirm expensive steps first.

## Working with project data

A project is one JSON blob (script, storyboard scenes, shot cards, visual assets, production timeline). To inspect: `videodraft projects get <id>`. To edit: fetch `--raw`, modify, then `videodraft call update_project` — objects deep-merge, **arrays replace wholesale** (send the complete `storyboard.scenes` array to change one scene). Snapshot first with `videodraft checkpoint create <id>` before risky edits. Schema reference: `videodraft call get_project_schema`.

## More

- [references/pipeline.md](references/pipeline.md) — project data model, step-by-step tools, attaching media, editing safely
- [references/models.md](references/models.md) — choosing image/video models, pricing patterns, voices and styles
- [references/examples.md](references/examples.md) — recipes: batch product videos from a CSV, talking-head from a script, changelog video in CI
