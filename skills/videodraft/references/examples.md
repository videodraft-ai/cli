# Recipes

Working patterns for common asks. All assume auth (`videodraft login` once, or `VIDEODRAFT_API_KEY` in the environment) and use `--json` for parsing.

Inside VideoDraft ADE, if a native editor is available, use these recipes for asset generation and
optional script/storyboard stages. Hand the results to the editor for production and export ONLY
when the deliverable the user asked for is a composed production. A standalone output — the batch
product clips in recipe 1, the upscale in recipe 7 — is finished when it is generated; importing it
into a project and exporting a timeline builds an edit nobody asked for. Recipes below that call `videodraft produce` or `videodraft export` are hosted fallbacks only. Do not choose them over the available native editor unless the user explicitly asks for the hosted web workflow.

## 1. Batch product videos from a CSV

One 9:16 product clip per row of `products.csv` (`name,image_url,tagline`):

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p outputs

while IFS=, read -r name image tagline; do
  job=$(videodraft generate video \
    "Premium product shot of ${name}: ${tagline}. Slow orbit, studio lighting." \
    --model gemini-omni-flash --ar 9:16 --duration 6 \
    --start-image "$image" \
    --no-wait --json | jq -r .job_id)
  echo "$name,$job" >> outputs/jobs.csv
done < <(tail -n +2 products.csv)

# Collect ALL results with ONE process (batched polling — one request per tick)
videodraft wait $(cut -d, -f2 outputs/jobs.csv) \
  --download "outputs/{job_id}_{index}.{ext}" --json > outputs/results.json
# map job ids back to product names via outputs/jobs.csv
```

Submit-then-collect parallelizes server-side generation; the single multi-id `wait` keeps it to one local process and one batched poll request per tick no matter how many jobs. Gemini Omni Flash is selected because these are six-second first-frame product clips. Estimate first: `videodraft costs gemini-omni-flash --type video --duration 6 --resolution 720p --audio` × rows, and confirm with the user.

## 2. Hosted full marketing video from one idea (fallback)

```bash
videodraft create "30-second launch video for Solace, a sleep-tracking ring. Calm, premium, dark palette." \
  --ar 9:16 --style cinematic --json > project.json
PROJECT=$(jq -r .project_id project.json)

videodraft shots "$PROJECT" --grid --estimate          # show the user the cost; get a go-ahead
videodraft shots "$PROJECT" --grid
videodraft produce "$PROJECT"
videodraft generate music "minimal ambient, warm pads, 60 BPM" --attach "$PROJECT"
videodraft generate audio "Extend @Audio1 into a 20-second transition" --ref-audio ./intro.wav --format wav --download ./transition.wav
videodraft export "$PROJECT" --download solace-launch.mp4
```

Use this complete hosted path only when the user requested a web project or the native editor is unavailable. Otherwise stop after the storyboard/assets, import them into the native `.vdproject`, and export with `export_project`. The hosted project stays editable at the URL in `project.json` (`.urls`).

## 3. Talking-head (avatar) video

When the user has no portrait, generate a clear front-facing avatar image first. Skip this step when they supplied one or an existing character should be reused.

```bash
videodraft generate image \
  "Front-facing head-and-shoulders portrait of a friendly coffee expert, direct eye contact, natural expression, clean studio background" \
  --model nano-banana-2 --ar 9:16 --download ./media/avatar.png

SCRIPT=$(videodraft avatar script "why our espresso subscription saves you money" --style ad-style --json | jq -r .script)
AVATAR=$(videodraft avatar create ./media/avatar.png --script "$SCRIPT" --voice elevenlabs-kPzsL2i3teMYv0FxEYQ6 --ar 9:16 --json | jq -r .avatar_video_id)
videodraft avatar render "$AVATAR" --resolution 720p   # VEED Fabric paid step; confirm cost first (~20 credits/sec)
```

`avatar script` and `avatar create` (including speech) are bundled/free. In this example only the optional portrait generation and Fabric render spend credits.

If the portrait is low resolution, enhance it before `avatar create`:

```bash
videodraft upscale image ./founder-small.jpg --scale 2x --download ./media/founder-upscaled.png
```

For a one-off portrait animation without creating a managed avatar record:

```bash
videodraft avatar fabric ./founder.jpg \
  --text "Welcome to the weekly product update." \
  --voice-description "warm, confident American presenter" \
  --resolution 720p --download ./media/presenter.mp4
```

When the user already has both the video and replacement speech:

```bash
videodraft avatar lipsync ./presenter.mp4 \
  --audio ./localized-voiceover.mp3 \
  --sync-mode loop --download ./media/presenter-localized.mp4
```

Edit an existing video with a dedicated edit model:

```bash
videodraft models video --category video_edit
videodraft edit video ./product-demo.mp4 \
  "Turn the room into a warm evening scene while preserving the product and camera motion" \
  --model wan-2.7-ref-edit --ref ./evening-style.jpg \
  --preserve-audio --download ./media/product-demo-evening.mp4
```

Transfer motion from a reference clip onto a character image:

```bash
videodraft edit motion ./character.png \
  "Apply the dancer's movement to this character while preserving identity" \
  --motion-video ./dance-reference.mp4 \
  --model kling-v3-motion-control --quality pro \
  --download ./media/character-dance.mp4
```

## 4. Hosted changelog video in CI

In a GitHub Action with `VIDEODRAFT_API_KEY` set as a secret:

```bash
NOTES=$(git log --oneline v1.2.0..HEAD | head -20)
videodraft create "Weekly product update video. Energetic, 20 seconds. Changes: ${NOTES}" --ar 16:9 --json > p.json
PROJECT=$(jq -r .project_id p.json)
videodraft shots "$PROJECT" && videodraft produce "$PROJECT"
videodraft export "$PROJECT" --download changelog.mp4 --wait-timeout 30m
```

## 5. Variations and picking a winner

```bash
videodraft generate image "logo concept: minimalist fox, geometric" --num 4 --download "./concepts/{job_id}_{index}.{ext}" --json
# Show all 4 to the user; regenerate the chosen one at higher res:
videodraft generate image "<same prompt>" --model nano-banana-pro --resolution 4K
```

## 6. Reaching tools without a curated command

```bash
videodraft tools list --json | jq -r '.[].name'
videodraft tools schema attach_media_to_shot --json
videodraft call attach_media_to_shot --args '{"project_id":"...","scene_index":0,"shot_index":1,"media_url":"https://...","media_type":"video","duration_seconds":6}'
```

Anything the hosted VideoDraft MCP exposes, including character studio, product studio, and hosted project data, is reachable this way even before it gets a curated command. Native `.vdproject` editing uses the separate `videodraft_editor` MCP described in SKILL.md.

## 7. Enhance an existing asset without changing it

```bash
# Light image cleanup, no enlargement
videodraft upscale image ./poster.png --scale 1x --download ./media/poster-enhanced.png

# General image and video enlargement
videodraft upscale image ./frame.png --scale 2x --download ./media/frame-2x.png
videodraft upscale video ./clip.mp4 --scale 2x --download ./media/clip-2x.mp4
```

Use these when the content is correct and only quality or resolution needs improvement. If the poster text, composition, subject, or motion is wrong, edit or regenerate instead.
