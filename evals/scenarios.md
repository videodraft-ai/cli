# VideoDraft skill evaluations

Manual regression scenarios for the `videodraft` skill. Anthropic ships the eval
*format* but no runner, so treat these as a checklist: run each prompt against an
agent that has the skill loaded (and the CLI authed) and confirm the expected
behavior. Update these when the skill changes.

Each scenario: the request, and what a correct run must and must not do.

## 1. Standalone image stays in the asset lane

- **Query:** "Make a 16:9 cinematic image of a red fox in snow."
- **Must:** run `videodraft generate image ... --ar 16:9`; report/download the output URL.
- **Must NOT:** create a project, build a storyboard.

## 2. Variations use --num, never a loop

- **Query:** "Give me 4 variations of a minimalist coffee-brand logo."
- **Must:** a single `videodraft generate image ... --num 4` call.
- **Must NOT:** call generate four times in a loop.

## 3. Standalone video with the default model + cost confirmation

- **Query:** "Make a 6-second video of a slow dolly over a misty lake."
- **Must:** default to `google-veo3.1`; check/quote cost (`--estimate` or `videodraft costs`) before spending; run `videodraft generate video`.
- **Must NOT:** create a project.

## 4. Voiceover is a complete deliverable

- **Query:** "Read this script in a warm female voice and save the mp3."
- **Must:** `videodraft generate voiceover ...`; save/report the audio file.
- **Must NOT:** create a project or a video.

## 5. A multi-scene ad becomes a project

- **Query:** "Turn this idea into a 30-second vertical ad."
- **Must:** `videodraft create "<idea>" --ar 9:16`; follow the pipeline (shots → produce → export) as requested; confirm cost before the shot-image batch.
- **Must NOT:** generate standalone clips and stitch them by hand.

## 6. Batch of jobs uses one waiter

- **Query:** "Generate images for these 10 prompts."
- **Must:** submit with `--no-wait`, then one `videodraft wait <id...>` for all.
- **Must NOT:** spawn parallel `generate --wait` processes, or re-submit on a wait timeout.

## 7. Talking-head uses the avatar flow

- **Query:** "Make a 20-second presenter video from this script."
- **Must:** use `videodraft avatar script` → `avatar create` → `avatar render` (confirm the paid render).
- **Must NOT:** treat it as a generic `generate video` call.

## 8. Showing results renders inline

- **Query:** (after any generation) "show me the result."
- **Must:** save locally and reference the local path as a Markdown link in the reply (`[shot](./media/shot.png)`).
- **Must NOT:** dump a bare CDN URL or use a file-send tool.
