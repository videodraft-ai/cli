---
name: videodraft
description: Create and edit AI videos, images, Seed Audio, voiceovers, music, sound effects, dialogue, dubbing, storyboards, avatar videos, media upscales, and product/ad videos with VideoDraft. Use whenever the user mentions VideoDraft; asks to generate a video, image, audio asset, ad, explainer, storyboard, avatar, upscale, or batch/CI workflow; or wants to assemble, cut, caption, mix, lay out, inspect, or export a native VideoDraft Editor timeline. Covers the cloud `videodraft` CLI/MCP and local headless `videodraft_editor` MCP. When the editor MCP is exposed, prefer it for production, timeline assembly, and export; use cloud production/export only when explicitly requested or the editor is unavailable.
---

# VideoDraft

VideoDraft is an AI video creation platform where asset generation is the priority lane:

- **Asset generation**: standalone images, video clips, Seed Audio, voiceovers, music, sound effects, dialogue, voice-changed audio, dubbed media, upscales, and image descriptions. This is the fastest and most important lane. Treat these as complete deliverables when the user asks for assets.
- **Asset I/O**: upload local files, download outputs, auto-upload local references, and save generated media where the user can see it.
- **Native editing**: local `.vdproject` timelines, cuts, layouts, captions, effects, audio, and exports through the headless VideoDraft Editor. Inside VideoDraft ADE, this is the default production and export lane whenever `videodraft_editor` is available.
- **Hosted project production**: idea → script → storyboard → hosted production timeline → exported MP4. Use the early stages for scripts, storyboards, and generated assets when useful. Treat hosted production and export as a fallback when the native editor is unavailable, or as an explicit destination when the user asks for an editable web project or hosted workflow.

## How to connect

Cloud generation has two equivalent surfaces (same backend, credits, and hosted projects). Native timeline editing is a separate local surface:

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
3. **Native editor MCP** (`videodraft_editor`): prefer this for project production, timeline assembly, cutting, layouts, transitions, captions, audio placement, and final export. Inside VideoDraft ADE on a supported Mac, Claude and Codex receive it automatically in both Code and VideoDraft modes. It runs headlessly, so an Open Editor click is not required. Start with `project_control` (`list`, `open`, or `create`); standalone asset generation remains in the cloud CLI or MCP.

Native editor mutations are revision-guarded. Send them serially and carry forward each result's fresh revision. See [references/editor.md](references/editor.md) for project selection, media import, timing units, mutation deltas, verification, export, and the `videodraft-editor` terminal bridge.

If you are reading this skill through `videodraft skills show skill`, run `videodraft skills show editor` before native editor work to load that reference.

**VideoDraft ADE routing rule:** the presence of `videodraft_editor` means the native editor is ready, even when no editor window is visible. Use cloud tools to generate or source assets and, when helpful, scripts or storyboards. Do not call hosted `produce_project` / `videodraft produce` or `export_video` / `videodraft export` by default. Import the assets into the native project, assemble there, and call native `export_start`. Use hosted production/export only when the user explicitly asks for the web workflow or the native editor tools are unavailable. Do not silently fall back to hosted production after a native tool error.

## First decision: asset, hosted project, or native edit?

- **One standalone asset** (image, clip, voiceover, music track, sound effect, dialogue track, voice-changed file, dubbed media file, upscale, or description): generate it directly. Do NOT create a project.
  - `videodraft generate image "a red fox in snow, cinematic" --ar 16:9 --download ./out/`
  - `videodraft generate video "slow dolly over a misty lake" --model gemini-omni-1.1-flash --duration 6 --download ./out/`
- **Any final video, production timeline, existing footage, local `.vdproject`, or hands-on edit**: use `videodraft_editor` when available. List or open the intended local project, or create a native project for a new production. The editor can work without showing its UI.
- **A small set of related assets**: still stay in the asset lane. They are grouped automatically (see [AI Studio sessions](#ai-studio-sessions)); give the current group one useful task-specific name with `videodraft sessions name "<name>"`. Switch to a project only when the deliverable matches the project criteria below or the user asks to attach the assets to one.
- **A generated multi-scene video / ad / explainer**: when the editor is available, use hosted tools only for any needed script, storyboard, shot planning, or generated assets; stop before hosted production, import the assets, and build/export the native timeline. A hosted project is optional unless the user wants the web project or its storyboard workflow.
- **A hosted web project or hosted export**: use the hosted pipeline only when the user explicitly asks for it or the native editor is unavailable.
- **Just a script** (no video asked for): A script-only request creates a script-stage project but stops at the script. Use `videodraft create "..." --script-only`; do not build a storyboard the user didn't ask for.
- **Iterating on existing work**: identify the surface first. Use `project_control` with `action:'list'` for native projects and `videodraft projects list` only for hosted work. Never create a replacement project just to change an existing one.

## Choose the model from the task

If the user names a model, use it when compatible. If it cannot handle the request, explain why and recommend alternatives instead of silently switching. Otherwise inspect the inputs, duration, audio, quality, speed, and cost, check the live catalog, and pass an explicit model.

### Seedance 2.x real-person rule

Seedance 2.0 and 2.5 require an explicit, higher-priced routing choice for real-person likenesses:

- Enable real-person support on the first request when supplied visual input media visibly contains a real identifiable person. This includes a start frame, end frame, reference image, or reference video. Keep the lower-priced Byteplus default for text-only requests, non-people, anime, and clearly synthetic or stylized characters that are not identifiable real people. For MCP use `allow_real_people: true`. For the CLI use `--allow-real-people`. Pass the same value to `get_model_costs` or `videodraft costs` so the estimate matches the charge.
- The default is false. It uses the lower Byteplus-priced path, and a Byteplus likeness-policy refusal does not fall back to Fal. Enabling the option keeps Byteplus first but permits a submit-time fallback to Fal, which allows real-person likenesses. The request is charged at Fal's higher tier-specific rate even if Byteplus serves it.
- If a request made without the option fails with code `SEEDANCE_REAL_PERSON_OPT_IN_REQUIRED`, estimate the higher rate, follow the user's spend-confirmation preference, and retry exactly once with the option enabled. The structured recovery fields are `retryable: true`, `retry_with: { allow_real_people: true }`, `cli_flag: "--allow-real-people"`, and `retry_policy: "once"`. CLI `--json` submit errors expose them under `details`; `status` and `wait` include them on the failed job result. Do not treat an unrelated moderation or provider error as that signal.
- Do not loop if the option was already enabled. Byteplus can accept a task and reject its generated output later. VideoDraft refunds that failed generation, but the late asynchronous failure cannot be rerouted to Fal. Rephrase the prompt or use different references before trying again.
- For hosted AI Production, the same choice applies to every Seedance scene segment. Use `produce_project` with `mode: "full_video", allow_real_people: true`, or `videodraft produce <project> --mode full_video --allow-real-people`. If an earlier run partially submitted and returns the opt-in code, rerun that same project once with the option. The server reconciles asynchronous results first, preserves running/completed jobs, and resubmits only failed scene-video placeholders carrying the exact opt-in signal. Keep the native-first VideoDraft ADE routing rule above: hosted full-video production is still explicit/fallback-only when the local editor is available.

Every `videodraft models image|video|audio --json` response carries a top-level `recommended` array (best first) and stamps `recommended` / `recommended_for` on each entry. That is the authoritative preference order and it beats this page when they disagree. Preferred today: images `nano-banana-2`, `nano-banana-pro`, `gpt-image-2`; videos `gemini-omni-1.1-flash`, `seedance-2.5`, `seedance-2`, `kling-3.0`, `kling-v3-turbo`, `kling-o3`; video edits `gemini-omni-1.1-flash`; talking heads `veed-fabric`; motion transfer `kling-v3-motion-control`; audio ElevenLabs for anything with a voice and Lyria for instrumental music. Preference applies only when the user did not name a model.

**Images:**

- `nano-banana-2`: general default, editing, consistency, and references.
- `nano-banana-pro`: maximum quality. `nano-banana-2-lite`: fast, inexpensive drafts.
- `gpt-image-2`: posters, logos, signs, title cards, readable text, or precise composition/editing.

**Videos:**

- `gemini-omni-1.1-flash`: general default for 3-10s generation and uploaded source edits up to 10s. It supports first and last frames, up to 10 total image inputs, up to 3 creative reference videos of at most 3 seconds each on `--video-task generate` ONLY, uploaded-video extension, and continuation of an earlier generation through `--previous-interaction-id`. Output is 360p/720p/1080p/4K at 3/10/15/30 cr/s with audio always on. Use `--source-video` for the uploaded edit/extension source; extension sources must be 1-30s. Edit and extend accept EXACTLY ONE input video, so `--ref-video` cannot accompany `--source-video` or `--previous-interaction-id`; only `--ref` images can. One `--ref-video` with no separate source remains a legacy source edit. A previous interaction defaults to conversational edit; add `--video-task extend` or `--extend` with an explicit 3-10s duration to append at the end. A continuation resolves to the prior turn's output and is submitted as an ordinary source, so the same limits apply to it: at most 30s to extend, at most 10s to edit. 40 seconds total is reachable, but only by extending from a source of 30s or less, so a ladder dead-ends once it passes 30s. New dialogue can only be added when the SOURCE video is silent; adding speech on top of a source that already contains speech is refused with "the model is currently unable to process speech edits". The server safely measures creative-reference durations, or you can repeat `--ref-video-duration` when a host blocks metadata probing. Fal BYOK supports its currently callable v1.1 generation and basic-edit endpoints at zero VideoDraft credits, but Fal does not expose continuation/extension or mixed source-edit references as callable endpoints and VideoDraft must never fall back to paid Google.
- `grok-imagine-video-1.5`: 1-15s text, first-frame, or 1-7 reference-image generation with native audio. Text/first-frame modes support 480p, 720p, and 1080p; reference mode supports 480p/720p. Cite references as `<IMAGE_0>` through `<IMAGE_6>`. It has no last frame, seed, negative prompt, quality tier, reference video, or reference audio.
- `minimax-h3`: 480p/768p/2K/4K (5/6/13/16 cr/s, 768p default), native stereo audio, and 5-15s text, first/last-frame, or mixed-reference generation. Reference mode accepts up to 9 images, 3 videos, and 3 audio clips, with at most 12 files total. Cite them as `Image 1`, `Video 1`, and `Audio 1` in array order.
- `minimax-h3-max`: 480p/768p pricing (5/8 cr/s, 768p default), native audio, and 5-15s text, first/last-frame, or mixed-reference generation. Reference mode accepts up to 9 images, 3 videos, and 3 audio clips, with at most 12 files total, cited as `Image 1`, `Video 1`, and `Audio 1` in array order. It supports a reproducibility seed and `disabled` / `balanced` / `quality` prompt expansion.
- `wan-3.0`: unified 2-30s text, first/last-frame, or ordered mixed-reference generation at 480p/720p/1080p (7/14/28 cr/s), with optional native audio. Reference mode accepts up to 10 images, 5 videos, and 5 audio clips, at most 20 media files total; video and audio each total at most 15 seconds. `--auto-duration` reserves 30 seconds and reconciles to the provider-reported output length. Document/web references use `--file-url` or `--web-url` and require `--thinking`.
- `flux-3`: Black Forest Labs FLUX 3. 5-20s at 720p/1080p with 24fps native audio, from a prompt, a first frame, first + last frames, or up to 10 keyframes pinned to specific moments (`--keyframe shot.png@2.5`, repeatable). `--quality draft` renders the same shot at 720p for roughly a third of the cost — use it to check blocking before committing. Auto duration is text/first-frame only.
- `seedance-2`: 11-15s, video/audio/mixed references, wider ratios, selectable audio, or first/last frames. Use `mini` for cost, `fast` for speed, `standard` for quality or 1080p/4K.
- `seedance-2.5`: 4-30s single takes and up to 50 references (30 image, 10 video, 10 audio). Same modes as 2.0, one quality tier, 480p/720p/1080p. Reach for it when a shot must run past 15s or carry more references than 2.0 allows.
- `kling-v3-turbo`: fast polished 3-15s with first frame, multi-prompt, and audio, but no elements. `kling-o3`: reference images plus structured image/video elements, first/last frames, multi-prompt, audio control, or 4K. O3 allows 7 combined image references and image-backed elements, reduced to 4 combined items when a video-backed element is present. `kling-3.0`: image-to-video can use structured image/video elements and bind a custom Kling voice ID to either element form. Kling 2.6 Pro uses top-level voice IDs cited as `<<<voice_1>>>` and `<<<voice_2>>>`.
- Existing-video edits use `videodraft edit video`, not generic generation. `gemini-omni-1.1-flash` is the preferred edit model and is chosen automatically when you omit `--model`: source up to 10s, up to 10 reference images, 360p/720p/1080p/4K with audio. Creative `--ref-video` inputs are NOT accepted on an edit, because an edit takes exactly one input video; use `generate video --video-task generate` to guide a new clip with video references instead. Omitting `--model` on a longer or unmeasurable source spends nothing and prints a priced menu (what each model edits, what it drops, what it costs) so you can put the choice to the user. **Truncation:** only Gemini refuses an over-length source. Happy Horse silently edits just the first 15s, Kling O3 the first 10s, and Grok the first 8s. The command warns you when that will happen; always relay it to the user. Gemini regenerates the audio track, so use Happy Horse or Kling O3 with `--preserve-audio` when the source audio must survive. Choose Grok for the cheapest prompt-only edit, Happy Horse for up to 5 image references, or Kling O3 for controlled reference-image edits.
- To edit a source longer than 10s without losing its tail, cut it into <=10s pieces in the native editor, edit each with Gemini, and reassemble. VideoDraft has no server-side split/concat, so this path needs `videodraft_editor`.
- Kling O3 also has a reference-generation mode. Use `videodraft generate video --model kling-o3-video-ref-edit` with exactly one `--ref-video` to generate a new guided clip; use `videodraft edit video` when changing the source itself. Use Wan 3.0 for new mixed-reference generation, not source-video editing.
- Motion transfer uses `videodraft edit motion` with Kling V3 by default, or Kling 2.6 when explicitly requested or lower cost matters. It requires a subject image and a motion-reference video.
- Use Veo 3.1 when explicitly requested or as a fallback.

**Audio and utilities:**

- Use Seed Audio 1.0 for open-ended text-to-audio, speech/music/sound synthesis, voice conditioning, or prompt-driven editing with up to three audio references or one image. Use `videodraft generate audio`. Reference clips are `@Audio1`, `@Audio2`, and `@Audio3` in array order. There is no duration input. Output is up to two minutes and settles at 19 credits per actual minute, with up to 38 credits reserved during generation. The CLI automatically retries transient responses with one operation key. To recover after the CLI process itself is interrupted, set `--idempotency-key <uuid>` on the original command and reuse it.
- Prefer ElevenLabs for voiceover, dialogue, voice changing, dubbing, and sound effects. Honor an explicitly selected supported TTS voice/provider. Use Lyria for instrumental music and ElevenLabs Music for vocals, lyrics, or exact timing.
- A character who needs to TALK, when you have an image of them, splits by FRAMING:
  - **Talking to camera** (presenter, spokesperson, explainer): the avatar lane, and VEED Fabric is preferred. Use managed `avatar create` then `avatar render` for a reusable avatar record with bundled speech, `avatar fabric` for a one-off portrait plus text or existing audio, and `avatar lipsync` when both the source video and replacement audio already exist.
  - **Speaking inside a scene** (real blocking, framing, camera movement): not Fabric. It animates a portrait facing the lens, so a cinematic request comes back as a head-on talking headshot. Use `generate video` with `kling-2.6-pro` (one or two voices cited as `<<<voice_1>>>` / `<<<voice_2>>>`), `kling-3.0` (a voice bound per element, so several characters can speak in one shot), or `happy-horse` (strong character identity from a frontal image, native audio, multilingual lip-sync).
- Enhancement: use Topaz image/video upscaling only when the content is already correct. Use image 1x for cleanup, 2x by default, 4x when justified; use video 2x by default. Edit or regenerate creative errors.

See [references/models.md](references/models.md) for the detailed routing table and exact capability limits.

## Prefer references when continuity matters

Pure text-to-image or text-to-video is fine for a generic one-off asset. When a specific character, product, location, style, composition, or brand identity must survive generation, use references instead of hoping the prompt recreates it.

- If the user supplies reference media, preserve and pass it. Never reduce the request to text alone.
- When continuity matters, generate/select a strong still first with the selected image model (`nano-banana-2` by default), wait for its URL, then animate it as a start frame/reference. Confirm the combined image and video cost.
- When using a hosted storyboard stage for multiple shots, use `videodraft shots <project_id> --model <selected-image-model> --grid`, then animate the decoded shots. Preserve explicit models. In VideoDraft ADE, import the resulting assets into the native editor instead of continuing into hosted production. A requested non-Seedance video model must use manual per-shot generation instead of Seedance full-video mode.

## Cost and credits

Do not call `videodraft credits` before routine generations. Paid endpoints validate and deduct atomically; if the balance is insufficient, the request is rejected before the provider job starts (CLI exit code 4). Check the balance only when the user asks, gives a credit budget, or a large workflow needs budget planning.

For expensive work, estimate with `--estimate` or `videodraft costs`, state the selected model/settings/cost, and get a go-ahead. This matters most for shot-image batches, long or high-resolution video, AI Production, and paid audio batches. Honor the user's confirmation preference for the session.

Kling voice creation costs 1 VideoDraft credit on the platform Fal account and 0 credits with Fal BYOK. Preview it with `videodraft kling-voices create <sample> --name <name> --estimate`; the estimate does not create a voice or require consent confirmation. Actual creation requires `--confirm-consent`.

MiniMax H3 costs 5 / 6 / 13 / 16 credits per output second at 480p / 768p / 2K / 4K (768p by default). In reference mode the first 5 images are included and each additional image costs 8 credits. Reference video and reference audio are NOT billed.

MiniMax H3 Max costs 5 credits per output second at 480p and 8 credits per second at 768p (default), plus pooled reference tokens in reference mode: the first 4,096 are free and every 1,000 after that costs 2 credits, where an image is `(width x height) / 1024` tokens, a reference video is 2,886 tokens per second at 480p or 7,459 at 768p, and reference audio is about 2,121 per second. Use `--prompt-expansion-mode disabled|balanced|quality`; balanced is the default. Fal's provider safety checker is OFF by default and is not exposed in the app — only pass `--safety-checker true` if the user explicitly asks for it.

Wan 3.0 costs 7 / 14 / 28 credits per output second at 480p / 720p / 1080p. Auto duration reserves the 30-second maximum and refunds the unused reserve after the provider reports the actual whole-second output length. Fal BYOK runs on the connected user key and charges zero VideoDraft credits.

Grok Imagine Video 1.5 costs 8 credits per output second at 480p, 14 at 720p, or 25 at 1080p, plus 1 credit for each first-frame or reference image. Native audio is always generated.

`videodraft models image|video` lists the live image and video catalogs with supported inputs. Video entries are grouped as `generation`, `video_edit`, `motion_control`, `avatar_lipsync`, and `upscale`, and each reports the exact tool. Use `videodraft models video --category video_edit` to narrow the list. `videodraft models audio` lists Seed Audio, Google Lyria, and ElevenLabs audio/media tools, while `videodraft models voices` lists TTS voices. Consult them instead of guessing capabilities.

## Async jobs

Image/video generation is asynchronous: commands submit a job and **wait by default**, printing output URLs (and saving files with `--download`). Large downloaded images also get a downscaled copy in `previews/` next to them (the `preview` field / "inspect via preview" line in the output) — **look at the preview, deliver the original**; viewing full-resolution images bloats the chat permanently. In scripts/CI prefer explicit control:

```bash
JOB=$(videodraft generate image "..." --no-wait --json | jq -r .job_id)
videodraft wait "$JOB" --download "./outputs/{job_id}_{index}.{ext}" --json
```

For MANY jobs: submit each with `--no-wait`, collect ALL with one command — `videodraft wait <id1> <id2> ...` polls every job from one process with one batched request per tick. Do NOT spawn parallel `wait`/`generate --wait` processes for a batch.

If a wait times out, the job is still running server-side — `videodraft status <job_id>` later. Never re-submit just because a wait timed out (that double-spends credits).

For completed Wan 3.0 jobs, MCP `check_generation_status` and CLI `status`/`wait --json` include `outputMetadata` with Fal's returned `seed`, `duration`, and `actual_prompt` when present.

## AI Studio sessions

Every standalone (project-less) generation is filed into an AI Studio session in the web app. You do not have to create one:

- **MCP hosts** (Claude Code, claude.ai, Codex, VideoDraft ADE): the server mints an `Mcp-Session-Id` on `initialize`; your host echoes it, and this conversation's generations land in their own session. Tool results echo it as `ai_studio_session_id`.
- **CLI**: the same handshake runs once per (profile, server, working directory) and is cached for 12 idle hours, so everything generated from one directory shares one session. `videodraft sessions current` shows it; `videodraft sessions reset` starts a new one.
- Project generations (`--project <id>` / `project_id`) always go to that project's session.

Once you understand the creative task, name the current automatic session before the first standalone generation:

```bash
videodraft sessions name "Purple Seal Rescue Short"
```

Choose a concise, specific 3-6 word title for the intended work. Do not copy the client name, date, or exact chat title. Name it once: the operation creates the session with that title. If generation, a user, or an earlier agent created the session first, its existing name is preserved.

Pass `--session <id>` / `session_id` only to **continue earlier work** or create an explicit separate group:

```bash
SESSION=$(videodraft sessions create "Fox brand explorations" --json | jq -r '.session.id')
videodraft generate image "a red fox in snow, cinematic" --session "$SESSION"
videodraft generations --session "$SESSION"          # what is in it
videodraft sessions list --name fox                  # find it again later
```

`VIDEODRAFT_SESSION=<id>` sets the default for every command (ignored when `--project` is given). While it is set, `sessions name` refuses to run because that command names the current automatic connection session, not the pinned override; unset it first or rename the pinned session in AI Studio. `VIDEODRAFT_SESSION_SCOPE=<label>` groups several directories into one connection session; `VIDEODRAFT_CLIENT_NAME=<host>` labels the fallback placeholder used when generation creates the session before `sessions name`; `VIDEODRAFT_NO_SESSION=1` disables the handshake. Generations that reach the server with no session at all fall back to the account-wide "Agent (MCP)" session; if you see work landing there, pass `--session` explicitly.

## Generation history

Past work is queryable — reuse a previous setup instead of guessing. `videodraft generations` lists recent generations; scope with `--session <id>` or `--project <id>` (includes collaborators' rows in shared scopes; pass one, project wins), and filter with `--type`, `--model`, `--favorites`. `--full --json` returns each row's exact parameters (aspect ratio, resolution, duration, references) — the human table stays compact, so pair `--full` with `--json`. `videodraft generation <id>` prints one generation's complete recipe (prompt, input image, parameters, outputs); `--favorite` / `--unfavorite` stars it. `videodraft sessions list` shows AI Studio sessions (owned + shared) with `--name` search — take a session id from there to read its history.

## Local files and reference images

Reference inputs must be public URLs. The CLI uploads local files automatically wherever a URL is expected (`--ref photo.jpg`, `--start-image frame.png`), or explicitly:

```bash
URL=$(videodraft upload ./product.png --json | jq -r .url)
```

Never silently drop a reference you couldn't upload — stop and tell the user. Never upload a user's file to a third-party host.

When the user attaches media for a native production, import actual footage into the editor by default. For hosted generation/storyboarding, classify each item before acting: a recurring **visual asset** (character/product/location/style), actual **footage to place as shots**, or **inspiration only**. See [references/pipeline.md](references/pipeline.md) for the hosted role mapping.

## Showing media to the user

Generated media is **not** displayed in the chat automatically — you decide what to show. To preview an asset inline, save it locally (use `--download` so it lands under `media/`) and reference its **local path** as a Markdown link with a **leading `./`**:

```
[ferrari shot](./media/ferrari_01.png)     ← image card
[the clip](./media/clip.mp4)               ← video player
[voiceover](./media/vo.mp3)                ← audio player
```

Put the Markdown link **in your message text** — video and audio embed exactly like images. Do **not** use `SendUserFile` (or other file-send tools) to display media: that renders inside a collapsible tool card and gets buried in the tool list. The Markdown link in your prose is what produces the inline card.

Use the path you saved to: a **workspace-relative** path (`./media/clip.mp4`, or `./<any-folder>/clip.mp4` — any folder in the workspace works), or the **absolute** path for a file outside the workspace (e.g. `/Users/you/Desktop/clip.mp4` or another workspace's path). Both render. Show the finished results worth showing (and only those — not every intermediate job). A bare CDN URL or a JSON dump of output URLs does **not** render; the local-path Markdown link is what produces an inline card.

## Native-first VideoDraft ADE pipeline (idea → MP4)

When `videodraft_editor` is present:

1. Generate or source the script, storyboard, shot images, clips, voiceovers, music, and other assets through the cloud CLI/MCP as needed.
2. Call native `project_control` to open or create the `.vdproject`.
3. Call native `media_import`, wait for imports to become ready, then assemble and refine the timeline with editor tools.
4. Call native `export_start` and use `export_status` for progress and results.

Do not run the hosted production or export steps in this path unless the user explicitly asks for a web production.

## Hosted fallback pipeline (idea → MP4)

Use this only when there is NO native editor at all, or the user explicitly requests the hosted web
workflow. The native surface is not only the injected `videodraft_editor` MCP: a `videodraft-editor`
executable on PATH is the same editor reached through its terminal bridge, and
[references/editor.md](references/editor.md) covers driving it that way. Treating a missing MCP as
"no editor" sends sessions that have the binary into hosted production for no reason.

```bash
videodraft create "<idea>" --ar 9:16            # project: script → visual assets → storyboard
videodraft shots <project_id> --grid --estimate # cost preview, confirm with user
videodraft shots <project_id> --grid            # batch shot images (waits, writes onto shot cards)
videodraft produce <project_id>                 # voiceovers + captions + production timeline
videodraft export <project_id> --download final.mp4
```

Optional between produce and export: per-shot motion clips (`videodraft generate video ... --project <id>` then place it with `videodraft attach <project> --scene N --shot M --media <url|file> --type video --duration <s>`), music (`videodraft generate music "..." --attach <project_id>`), and standalone audio assets (`generate audio`, `generate sound-effect`, `generate dialogue`, `generate voice-changer`, `generate dub`). Details, per-step tools and editing rules: [references/pipeline.md](references/pipeline.md).

## Avatar and talking-head videos (both surfaces)

Avatar generation is cloud-only — the native editor has no avatar or lipsync tools — so this applies whether or not `videodraft_editor` is present. Generate the avatar in the cloud; in VideoDraft ADE, import the rendered clip and cut it on the native timeline like any other footage.

Avatar/talking-head videos use dedicated commands. For a reusable managed avatar, obtain or generate a clear portrait → `videodraft avatar script` when needed → `videodraft avatar create` → `videodraft avatar render --resolution 720p`. For a one-off portrait, use `videodraft avatar fabric <portrait> --text "..."` or `--audio <file>`. For an existing video plus replacement audio, use `videodraft avatar lipsync <video> --audio <file>`. Managed script/creation is bundled/free; direct Fabric, Sync, the managed Fabric render, and optional portrait generation/upscaling are paid. Confirm expensive steps first.

## Working with hosted project data

A hosted project is one JSON blob (script, storyboard scenes, shot cards, visual assets, production timeline). To inspect: `videodraft projects get <id>`. To edit: fetch `--raw`, modify, then `videodraft call update_project` — objects deep-merge, **arrays replace wholesale** (send the complete `storyboard.scenes` array to change one scene). Snapshot first with `videodraft checkpoint create <id>` before risky edits. Schema reference: `videodraft call get_project_schema`. This does not replace native editor tools when `videodraft_editor` is available for the production itself.

## More

- [references/pipeline.md](references/pipeline.md) — hosted fallback data model and production workflow
- [references/editor.md](references/editor.md) — native headless editor routing, project selection, import, timeline edits, verification, and export
- [references/models.md](references/models.md) — choosing image/video models, pricing patterns, voices and styles
- [references/examples.md](references/examples.md) — recipes: batch product videos from a CSV, talking-head from a script, changelog video in CI
