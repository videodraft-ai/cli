# Recipes

Working patterns for common asks. All assume auth (`videodraft login` once, or `VIDEODRAFT_API_KEY` in the environment) and use `--json` for parsing.

## 1. Batch product videos from a CSV

One 9:16 product clip per row of `products.csv` (`name,image_url,tagline`):

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p outputs

while IFS=, read -r name image tagline; do
  job=$(videodraft generate video \
    "Premium product shot of ${name}: ${tagline}. Slow orbit, studio lighting." \
    --model google-veo3.1 --ar 9:16 --duration 6 \
    --start-image "$image" \
    --no-wait --json | jq -r .job_id)
  echo "$name,$job" >> outputs/jobs.csv
done < <(tail -n +2 products.csv)

# Collect ALL results with ONE process (batched polling — one request per tick)
videodraft wait $(cut -d, -f2 outputs/jobs.csv) \
  --download "outputs/{job_id}_{index}.{ext}" --json > outputs/results.json
# map job ids back to product names via outputs/jobs.csv
```

Submit-then-collect parallelizes server-side generation; the single multi-id `wait` keeps it to one local process and one batched poll request per tick no matter how many jobs. Estimate first: `videodraft costs google-veo3.1 --type video --duration 6` × rows, and confirm with the user.

## 2. Full marketing video from one idea

```bash
videodraft credits --json
videodraft create "30-second launch video for Solace, a sleep-tracking ring. Calm, premium, dark palette." \
  --ar 9:16 --style cinematic --json > project.json
PROJECT=$(jq -r .project_id project.json)

videodraft shots "$PROJECT" --grid --estimate          # show the user the cost; get a go-ahead
videodraft shots "$PROJECT" --grid
videodraft produce "$PROJECT"
videodraft generate music "minimal ambient, warm pads, 60 BPM" --attach "$PROJECT"
videodraft export "$PROJECT" --download solace-launch.mp4
```

The project stays editable at the URL in `project.json` (`.urls`) — hand it to the user for tweaks.

## 3. Talking-head (avatar) video

```bash
SCRIPT=$(videodraft avatar script "why our espresso subscription saves you money" --style ad-style --json | jq -r .script)
AVATAR=$(videodraft avatar create ./founder.jpg --script "$SCRIPT" --ar 9:16 --json | jq -r .avatar_video_id)
videodraft avatar render "$AVATAR" --resolution 720p   # paid step — confirm cost first (~20 credits/sec)
```

## 4. Changelog video in CI

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

Anything the VideoDraft MCP exposes — character studio, product studio, timeline editing — is reachable this way even before it gets a curated command.
