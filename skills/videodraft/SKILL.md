---
name: videodraft
description: Create AI videos, images, voiceovers, music, sound effects, dialogue, dubbing, storyboards, avatar videos and product/ad videos with VideoDraft. Use when the user mentions VideoDraft, or asks to generate/make a video, video ad, explainer, storyboard, talking-head/avatar video, AI image, voiceover/TTS, background music, sound effects, dialogue audio, voice changing, or dubbing — including batch/programmatic video generation in scripts or CI. Works via the `videodraft` CLI (preferred in terminals) or the VideoDraft MCP connector.
---

# VideoDraft

VideoDraft is an AI video creation platform: idea → script → storyboard (scenes + shot images) → production (voiceover, captions, motion clips, music) → exported MP4. You can drive all of it from this environment.

## How to connect

Two equivalent surfaces (same backend, same credits, same projects):

1. **CLI** (preferred when you have a shell): run `videodraft` if it's on PATH; otherwise `npx videodraft` runs it with no install (needs Node ≥20; the package is fetched on first use and cached). For heavy use, `npm install -g videodraft`. If there's no Node/shell here but the MCP connector below is available, use that instead; if neither works, tell the user how to install (https://videodraft.ai/cli).
   - Auth — pick by context, don't guess:
     • INTERACTIVE (a human is in the session, e.g. Claude Code / Codex): on exit code 3 ("not authenticated"), tell the user to run `videodraft login` in their terminal — it opens their browser for a one-click VideoDraft sign-in (OAuth), no key to copy. Wait for them to confirm it succeeded, then retry the command. This is the preferred path when the user is present.
     • HEADLESS / CI (no browser): set `VIDEODRAFT_API_KEY=vd_mcp_...` (a token the user mints at https://app.videodraft.ai/mcp-keys).
     • SECURITY: never ask the user to paste a `vd_mcp_...` token into the chat — use browser `login` or the env var so the token never lands in the transcript.
   - Every command accepts `--json` (parse this, don't scrape text). Exit codes: 0 ok, 1 error, 2 usage, 3 auth (see Auth above), 4 insufficient credits (→ tell the user, don't retry).
   - Full API access: `videodraft tools list`, `videodraft tools schema <name>`, `videodraft call <tool> --args '<json>'`.
2. **MCP connector**: if VideoDraft MCP tools (e.g. `generate_storyboard_from_idea`) are available, call them directly — the CLI's curated commands map 1:1 onto these tools.

## First decision: asset or video?

- **One standalone asset** (a single image, clip, voiceover, music track, sound effect, dialogue track, voice-changed file, or dubbed media file, no story): generate it directly. Do NOT create a project.
  - `videodraft generate image "a red fox in snow, cinematic" --ar 16:9 --download ./out/`
  - `videodraft generate video "slow dolly over a misty lake" --model google-veo3.1 --duration 6 --download ./out/`
- **A video / ad / explainer / anything multi-scene**: create a project so the work stays organized, editable in the web app, and exportable.
  - `videodraft create "30s launch video for our espresso machine" --ar 9:16`
- **Just a script** (no video asked for): `videodraft create "..." --script-only`. Stop at the script — do not build a storyboard the user didn't ask for.
- **Iterating on existing work**: find it first (`videodraft projects list`) and reuse that project. Never create a new project to change an existing one.

## Credits: confirm before spending

Generation costs credits (video is per-second; shot-image batches are the largest single spend). Before anything expensive:

1. `videodraft credits` — check the balance.
2. `videodraft generate video "..." --estimate` or `videodraft costs <model> --duration 8 --resolution 1080p` — get the quote. For ElevenLabs audio, use `--type audio` plus `--duration`, `--length`, or `--chars`.
3. Tell the user the model + settings + rough cost and get a go-ahead. Ask rather than assume aspect ratio, duration, and model when they matter.

`videodraft models image|video|audio` lists every model with its supported inputs (aspect ratios, resolutions, reference limits, audio billing inputs) — consult it instead of guessing capabilities.

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

## The full pipeline (idea → MP4)

```bash
videodraft credits
videodraft create "<idea>" --ar 9:16            # project: script → visual assets → storyboard
videodraft shots <project_id> --grid --estimate # cost preview, confirm with user
videodraft shots <project_id> --grid            # batch shot images (waits, writes onto shot cards)
videodraft produce <project_id>                 # voiceovers + captions + production timeline
videodraft export <project_id> --download final.mp4
```

Optional between produce and export: per-shot motion clips (`videodraft generate video ... --project <id>` then place it with `videodraft attach <project> --scene N --shot M --media <url|file> --type video --duration <s>`), music (`videodraft generate music "..." --attach <project_id>`), and standalone audio assets (`generate sound-effect`, `generate dialogue`, `generate voice-changer`, `generate dub`). Details, per-step tools and editing rules: [references/pipeline.md](references/pipeline.md).

Avatar/talking-head videos are their own short flow: `videodraft avatar script` → `avatar create` → `avatar render` (paid step).

## Working with project data

A project is one JSON blob (script, storyboard scenes, shot cards, visual assets, production timeline). To inspect: `videodraft projects get <id>`. To edit: fetch `--raw`, modify, then `videodraft call update_project` — objects deep-merge, **arrays replace wholesale** (send the complete `storyboard.scenes` array to change one scene). Snapshot first with `videodraft checkpoint create <id>` before risky edits. Schema reference: `videodraft call get_project_schema`.

## More

- [references/pipeline.md](references/pipeline.md) — project data model, step-by-step tools, attaching media, editing safely
- [references/models.md](references/models.md) — choosing image/video models, pricing patterns, voices and styles
- [references/examples.md](references/examples.md) — recipes: batch product videos from a CSV, talking-head from a script, changelog video in CI
