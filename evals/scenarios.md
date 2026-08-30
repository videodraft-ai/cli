# VideoDraft skill evaluations

Manual regression scenarios for the `videodraft` skill. Anthropic ships the eval
_format_ but no runner, so treat these as a checklist: run each prompt against an
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

## 3. General standalone video selects Gemini + confirms cost

- **Query:** "Make a 6-second video of a slow dolly over a misty lake."
- **Must:** choose `gemini-omni-1.1-flash`; check/quote cost with the selected model before spending; run `videodraft generate video ... --model gemini-omni-1.1-flash`.
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
- **Must:** obtain or generate a clear avatar portrait, then use `videodraft avatar create` with the supplied script and an ElevenLabs voice → `avatar render --resolution 720p` with VEED Fabric (confirm the paid render). Do not call `avatar script` because the user already supplied one.
- **Must NOT:** treat it as a generic `generate video` call.

## 8. Showing results renders inline

- **Query:** (after any generation) "show me the result."
- **Must:** save locally and reference the local path as a Markdown link in the reply (`[shot](./media/shot.png)`).
- **Must NOT:** dump a bare CDN URL or use a file-send tool.

## 9. Fifteen-second native-audio video does not use Gemini

- **Query:** "Make a polished 15-second product video with native sound."
- **Must:** choose `kling-v3-turbo`, `kling-o3`, `kling-3.0`, or `seedance2` based on the requested controls; pass the chosen model explicitly.
- **Must NOT:** choose `gemini-omni-1.1-flash`, whose output is limited to 10 seconds.

## 10. Video and audio references select Seedance

- **Query:** "Use this video for the motion and this audio track as a reference for a 12-second clip."
- **Must:** upload/pass both references and choose `seedance2` explicitly.
- **Must NOT:** drop either reference or choose Gemini/Kling without support for the supplied audio reference.

## 10a. A 25-second single take selects Seedance 2.5

- **Query:** "Make one continuous 25-second product demo with sound."
- **Must:** choose `seedance-2.5` explicitly — it is the only model that generates a single take longer than 20 seconds — and note it renders at 720p.
- **Must NOT:** choose `seedance2`, Kling, or Veo (all capped at 15s), or silently split the request into multiple clips without saying so.

## 10b. More references than Seedance 2.0 allows selects Seedance 2.5

- **Query:** "Here are 12 product photos and 5 clips — keep every one of them consistent in a 10-second spot."
- **Must:** choose `seedance-2.5` (up to 30 image, 10 video, and 10 audio references) and pass all supplied references.
- **Must NOT:** choose `seedance2` or `minimax-h3` and silently drop references past their 9-image / 3-video caps.

## 10c. Explicit MiniMax H3 Max keeps its distinct controls

- **Query:** "Use MiniMax H3 Max for an 8-second 768p first-to-last-frame clip. Use quality prompt expansion and seed 42."
- **Must:** choose `minimax-h3-max`, pass both frames, `--prompt-expansion-mode quality`, `--seed 42`, and keep the safety checker enabled. Quote the 8 credits per second 768p rate.
- **Must NOT:** choose `minimax-h3`, pass reference media, add an aspect ratio alongside the start frame, or collapse the prompt expansion mode to the Wan boolean flag.

## 11. Source-video editing selects Gemini

- **Query:** "Edit this existing video into a rainy night version, about 8 seconds."
- **Must:** choose `gemini-omni-1.1-flash` and pass the source with `--ref-video`.
- **Must NOT:** treat the video as a first-frame image or create a project.

## 12. Image model follows quality and speed intent

- **Query:** "Make a quick inexpensive draft image, then I may refine it."
- **Must:** choose `nano-banana-2-lite` explicitly.
- **Must NOT:** blindly use the platform default or ask the user to select from the full catalog.

## 13. Poster text selects GPT Image 2

- **Query:** "Create a movie poster with the exact title THE LAST SIGNAL and the tagline WE WERE NEVER ALONE."
- **Must:** choose `gpt-image-2` explicitly and preserve the exact requested text in the prompt.
- **Must NOT:** choose a generic default without considering text-rendering quality.

## 14. Multi-shot character video uses a reference-first grid

- **Query:** "Make a three-shot sequence of the same detective entering an apartment, searching the desk, and finding a key. Keep him consistent."
- **Must:** create/reuse a project, generate the shot images with Nano Banana 2 grid mode, then use the decoded shot images as start frames or references for the motion clips.
- **Must NOT:** independently generate three text-only video clips with no shared visual anchor.

## 15. Talking-head without a portrait creates the avatar first

- **Query:** "Make a vertical talking-head video explaining compound interest. Create the presenter too."
- **Must:** generate a clear front-facing 9:16 portrait with `nano-banana-2`, wait for its finished URL/file, then use it with `videodraft avatar create` and render at 720p with VEED Fabric. Confirm the combined generation and render spend.
- **Must NOT:** call generic `generate video` or attempt the avatar render without a character image.

## 16. Image quality enhancement uses Topaz

- **Query:** "This photo is correct but soft and small. Improve the quality and make it twice as large."
- **Must:** run `videodraft upscale image <source> --scale 2x` and return the enhanced result.
- **Must NOT:** regenerate the photo with an image model and risk changing its content.

## 17. Video quality enhancement preserves the clip

- **Query:** "Upscale this existing low-resolution clip to 2x without changing the content."
- **Must:** run `videodraft upscale video <source> --scale 2x`, allowing the CLI to upload the local source and wait for the async result.
- **Must NOT:** use `generate video`, change the motion, or create a project.

## 18. Explicit video model overrides the task default

- **Query:** "Make a 6-second misty-lake clip using Veo 3.1."
- **Must:** pass `--model google-veo3.1` and use settings supported by Veo 3.1.
- **Must NOT:** replace it with Gemini Omni 1.1 Flash merely because Gemini is the general default.

## 19. Explicit image model survives the grid workflow

- **Query:** "Use GPT Image 2 to make a consistent three-shot storyboard of the same detective."
- **Must:** preserve `gpt-image-2` for the shot-image/grid generation and use the decoded shots as later video references.
- **Must NOT:** silently replace the requested image model with Nano Banana 2.

## 20. Incompatible explicit model is explained, not silently replaced

- **Query:** "Use Gemini Omni 1.1 Flash for a silent 15-second 4K video."
- **Must:** explain that Gemini Omni 1.1 Flash supports 4K but is limited to 3-10 seconds and always includes audio; recommend compatible alternatives for the requested 15-second silent output and wait for the user's choice.
- **Must NOT:** silently switch to Seedance, Kling, or Veo.

## 21. Explicit video model survives the project workflow

- **Query:** "Create a three-scene launch video and use Kling O3 for every generated motion clip."
- **Must:** create/reuse the project, establish consistent shot images, then pass `--model kling-o3` for each requested motion clip and attach the completed clips to the project timeline.
- **Must NOT:** use AI Production full-video mode, because that fixed path would silently replace the requested Kling O3 model with Seedance 2.

## 22. Routine generation skips the balance preflight

- **Query:** "Generate one 16:9 image of a lighthouse at dusk."
- **Must:** select the model and generate the image directly. If the paid request reports insufficient credits, surface the error and do not retry.
- **Must NOT:** call `videodraft credits` or `get_credits_balance` before this routine generation unless the user asked about their balance or supplied a budget.

## 23. Project scope follows the deliverable, not the word "project"

- **Query:** "Make a three-scene explainer about how heat pumps work, with a finished MP4."
- **Must:** create a project, build the storyboard and timeline, then export the final video even though the query never says "project."
- **Must NOT:** treat it as three unrelated standalone clips.

## 24. Script-only stops before storyboard production

- **Query:** "Write a 30-second launch-video script. I only need the script."
- **Must:** use `videodraft create "..." --script-only`, return the script-stage project/result, and stop.
- **Must NOT:** generate storyboard scenes, shot images, a production timeline, or an export.

## 25. Avatar preparation is free; Fabric render is paid

- **Query:** "Use this portrait and supplied script to make a 20-second talking-head video."
- **Must:** use `avatar create` without quoting or confirming a TTS charge, then estimate/confirm the VEED Fabric render at the chosen resolution before `avatar render`.
- **Must NOT:** describe `avatar create` or its bundled speech as a paid step. Optional portrait generation/upscaling remains separately paid when needed.

## 26. One-off portrait plus supplied audio uses direct Fabric

- **Query:** "Animate this portrait to speak this audio. I do not need a reusable avatar."
- **Must:** use `videodraft avatar fabric <portrait> --audio <audio>` and confirm the direct Fabric cost.
- **Must NOT:** create a managed avatar record or use generic `generate video`.

## 27. Existing video plus replacement audio uses Sync Labs

- **Query:** "Lip-sync this finished presenter video to this translated voiceover."
- **Must:** use `videodraft avatar lipsync <video> --audio <audio>` and preserve the supplied video and audio.
- **Must NOT:** send the video's first frame to Fabric or regenerate the presenter.

## 28. Existing-video edit uses the video-edit category

- **Query:** "Use this style image to turn my existing product clip into a warm evening scene. Keep its motion and audio."
- **Must:** run `videodraft edit video <video> "..." --ref <image> --preserve-audio` with an explicit active `--model` that can preserve source audio (`happy-horse-video-edit` or `kling-o3-video-ref-edit`), because the preferred default `gemini-omni-1.1-flash` regenerates the audio track.
- **Must NOT:** send the model id to generic `generate video`, replace the source video with a text-only generation, or claim Gemini Omni 1.1 Flash will keep the original audio.

## 28a. A plain source edit takes the preferred model by default

- **Query:** "Make it snow in this 6-second clip."
- **Must:** run `videodraft edit video <video> "..."` and let the server select `gemini-omni-1.1-flash`, or name it explicitly. No `--model` guess based on how many reference images were passed.
- **Must NOT:** default to `grok-imagine-video-edit`, `happy-horse-video-edit`, or another specialist when nothing about the request rules Gemini out. Wan 2.7 is retired and must not be suggested.

## 28b. A source longer than 10s surfaces the choice instead of truncating silently

- **Query:** "Restyle this 30-second clip to look like winter."
- **Must:** recognise that the preferred edit model caps the source at 10s, present the returned `needs_model_choice` options (what each model would edit, what it would drop, what it would cost) or the chunked native-editor route, and let the user decide.
- **Must NOT:** silently submit to a model that edits only the first 8-15 seconds, or report the result as a full-length edit. If a truncating model is chosen, say how many seconds are dropped.

## 29. Motion reference uses motion control

- **Query:** "Make this character image perform the movement in this dance clip."
- **Must:** use `videodraft edit motion <image> "..." --motion-video <video>` with Kling V3 Motion Control unless 2.6 is explicitly requested or lower cost is the priority.
- **Must NOT:** treat the motion video as general creative inspiration or omit the subject image.
