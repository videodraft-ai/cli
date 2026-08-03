# Choosing models (and predicting cost)

Always consult the live catalog instead of memorizing this page — models change weekly:

```bash
videodraft models image --json     # every image model + inputs (aspect ratios, resolutions, max refs)
videodraft models video --json     # every video model + inputs + per-second pricing metadata
videodraft models audio --json     # standalone audio/media models + pricing inputs
videodraft models voices --json    # TTS voices
videodraft models styles --json    # visual style presets
```

## Task-based model selection

Honor an explicitly named model when it supports the request. Otherwise choose from the task's inputs, duration, audio, quality, speed, and cost. Pass the chosen model explicitly instead of relying on a blind platform fallback.

### Images

| Need                                                                                   | Choose               | Why                                                               |
| -------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Most generation, editing, character consistency, or reference work                     | `nano-banana-2`      | Best general default; 1K/2K/4K and up to 14 reference images      |
| Highest-quality complex generation or reasoning                                        | `nano-banana-pro`    | Premium Nano Banana quality and reasoning                         |
| Fast, inexpensive drafts and iteration                                                 | `nano-banana-2-lite` | Fastest/cheapest Nano Banana option; 1K only, up to 14 references |
| Posters, title cards, signs, logos, or any image with important readable text          | `gpt-image-2`        | Strong text rendering; up to 16 image inputs and 1K/2K/4K output  |
| Complex multi-image composition, precise editing, or a strong alternate interpretation | `gpt-image-2`        | Strong non-Nano alternative with multi-image input                |

Use `--num 1..4` for variations of one prompt in a single call. Never loop separate paid calls for variations that fit in one request.

### Videos

| Need                                                                                                       | Choose              | Important limits                                                                                    |
| ---------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| Most text, first-frame, image-reference, or source-video-edit requests up to 10s                           | `gemini-omni-flash` | 720p, 3-10s or auto, audio always on, up to 10 total image inputs, one source video                 |
| Grok 1.5 text, first-frame, or 1-7 image-reference clips with native audio and optional 1080p              | `grok-imagine-video-1.5` | 1-15s; 480p/720p/1080p for text/first-frame; references are 480p/720p only; no last frame       |
| Fixed 2K with native stereo audio, first/last frames, or mixed image/video/audio references                | `minimax-h3`        | 5-15s; up to 9 image, 3 video, 3 audio refs, 12 files total; reference video/audio each total <=15s |
| Video/audio references, mixed reference media, broad aspect ratios, frame-mode first+last frame, or 11-15s | `seedance-2`        | 4-15s or auto; up to 9 image, 3 video, and 3 audio refs; audio toggle; Mini/Fast are 480p/720p only |
| Fast polished 3-15s video with first frame, multi-prompt, and native audio                                 | `kling-v3-turbo`    | Audio always on; Pro default; no end frame or reference-media mode                                  |
| Cinematic 3-15s with image references, first+last frame, multi-prompt, audio control, or 4K                | `kling-o3`          | Up to 7 image refs; Standard/Pro/4K; audio toggle                                                   |
| Kling 3-15s with first+last frame, multi-prompt, optional audio, or 4K, without reference-image mode       | `kling-3.0`         | Standard/Pro/4K; audio toggle                                                                       |
| User explicitly requests Veo, or the selected workflow specifically needs Veo                              | `google-veo3.1`     | Good fallback, but not the preferred general model                                                  |

Routing rules:

- Fixed 2K with native stereo audio: use MiniMax H3.
- Grok 1.5 reference mode accepts 1-7 images only. Address them in array order as `<IMAGE_0>` through `<IMAGE_6>`. Do not combine reference images with `--start-image`, `--end-image`, `--ref-video`, or `--ref-audio`.
- Grok 1.5 first-frame mode accepts one `--start-image`, derives the output aspect ratio from that image, and does not support `--end-image`. Text and first-frame modes support 480p, 720p, or 1080p. Reference mode supports 480p or 720p.
- Grok 1.5 always generates native audio. Do not pass `--no-audio`, `--seed`, `--negative`, or `--quality`.
- Around 11-15 seconds with native audio: use MiniMax H3, Kling, or Seedance, not Gemini.
- One existing source video that should be edited, with an output up to 10 seconds and no additional media references to preserve: use Gemini Omni Flash.
- Video or audio supplied as creative reference: use MiniMax H3 for fixed 2K/native audio, or Seedance 2.0 when resolution/quality tier or audio-toggle control matters.
- A video plus any image/audio references that must all be preserved: use MiniMax H3 or Seedance 2.0. Do not promise that Gemini will preserve mixed source media; its Fal BYOK edit mode accepts only the source video and prompt.
- First and last frame control: use MiniMax H3, Seedance, Kling O3, or Kling 3.0. Gemini supports a first frame but not a last frame.
- MiniMax H3 reference mode and first-plus-last-frame mode are separate. Audio cannot be the only reference. Address references as `Image 1`, `Video 1`, and `Audio 1` in array order.
- Seedance reference mode and first-plus-last-frame mode are separate. Do not promise reference video/audio plus a last frame in one generation.
- Multi-prompt sequencing: use Kling 3.0 Turbo, Kling O3, or Kling 3.0.
- Seedance quality: `mini` for the lowest cost, `fast` for speed, `standard` for maximum quality and for 1080p/4K.

### Video edit and motion-control categories

Use `videodraft models video --category video_edit` for existing-video transforms and `--category motion_control` for motion transfer.

| Need                                  | Command/model                                                         | Important limits                                                                 |
| ------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Simple prompt edit of one video       | `videodraft edit video <video> "..." --model grok-imagine-video-edit` | No image refs; source truncated to 8s; auto/480p/720p                            |
| Edit with one style/reference image   | `--model wan-2.7-ref-edit --ref <image>`                              | One image ref; 2-10s or match source                                             |
| Edit with several image references    | `--model happy-horse-video-edit --ref ...`                            | Up to 5 refs; 720p/1080p; source capped at 15s                                   |
| Controlled Kling edit                 | `--model kling-o3-video-ref-edit --ref ...`                           | Up to 4 refs; Standard/Pro; source clamped to 3-10s                              |
| Transfer reference motion to an image | `videodraft edit motion <image> "..." --motion-video <video>`         | Kling V3 default; image orientation caps motion at 10s, video orientation at 30s |

If the user explicitly names one of these models, preserve it. The CLI uploads local source videos and reference images automatically. Editing returns an async job and waits by default.

Kling O3 and Wan 2.7 Ref/Edit are dual-mode cards. `videodraft edit video` uses edit mode. `videodraft generate video --model kling-o3-video-ref-edit` requires exactly one `--ref-video` and generates a new reference-guided clip. `--model wan-2.7-ref-edit` generates a new clip from one or more `--ref`/`--ref-video` inputs.

### Reference-first video workflow

- Prefer a start frame or reference image whenever a specific character, product, location, style, composition, or brand identity must stay recognizable.
- If the user gives a reference, pass it. Never silently replace it with a text description.
- If no reference exists and continuity matters, generate a still first with the user's explicitly requested compatible image model, otherwise use Nano Banana 2. Wait for the image URL, then animate it with the selected video model. Confirm the combined image plus video cost before starting.
- For multi-shot scenes, generate shot images with `videodraft shots <project_id> --model <selected-image-model> --grid`. Preserve an explicitly requested compatible image model; otherwise use `nano-banana-2`. The grid establishes the scene and characters together, then decodes into individual shot images.
- Animate the decoded shot images as per-shot start frames or references. Do not independently text-generate each video clip when the shots need to match.
- Pure text-to-video remains appropriate for generic one-off footage where no subject, composition, or continuity needs to be preserved.

### Audio

- **Seed Audio 1.0**: use `videodraft generate audio` for open-ended speech, sound, music, or prompt-driven audio editing. It accepts up to three audio references or one image. Address audio references as `@Audio1`, `@Audio2`, and `@Audio3`. Preset and custom cloned voice IDs are supported. Output is up to 120 seconds. There is no requested-duration input. The CLI automatically retries transient responses with one idempotency key. To recover after the CLI process itself is interrupted, set `--idempotency-key <uuid>` on the original command and reuse it.
- **Voiceover/TTS**: prefer ElevenLabs. Brittney is the platform default voice; under ElevenLabs BYOK, use a compatible voice from the user's account. Honor another supported voice/provider when the user explicitly selects it.
- **Dialogue, voice changing, and dubbing**: ElevenLabs only.
- **Sound effects**: ElevenLabs Sound Effects only.
- **Music**: use `lyria-3-clip-preview` for a short instrumental/background score, `lyria-3-pro-preview` for a longer or higher-quality instrumental score, and `elevenlabs-music` when vocals/lyrics or a specified 10-120 second length matter.
- Voice Changer and Dubbing require the source media duration and currently accept source media up to 300 seconds.

### Avatar / talking head

Choose the dedicated path from the media the user already has:

| Starting media                            | Command                                                                   | Use                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Portrait + script, reusable avatar record | `videodraft avatar create <portrait> --script "..."` then `avatar render` | Managed avatar flow with bundled speech preparation |
| Portrait + text                           | `videodraft avatar fabric <portrait> --text "..."`                        | One-off direct VEED Fabric text mode                |
| Portrait + existing audio                 | `videodraft avatar fabric <portrait> --audio <audio>`                     | One-off direct VEED Fabric audio lip sync           |
| Existing video + existing audio           | `videodraft avatar lipsync <video> --audio <audio>`                       | Sync Labs Lipsync 2                                 |

The managed renderer is VEED Fabric Fast (`veed/fabric-1.0/fast`). Direct Fabric and Sync Labs are paid AI Studio generations and return async job IDs.

1. Obtain the avatar image. Prefer the user's supplied portrait or an existing character. If none exists, use the user's explicitly requested compatible image model, otherwise generate a front-facing head-and-shoulders portrait with `nano-banana-2`, direct eye contact, a natural expression, and a clean background. Match the intended video aspect ratio when practical.
2. If the portrait is visibly soft or too small, run Topaz image enhancement/upscaling before animation.
3. Generate a script only if needed: `videodraft avatar script "<idea>"`.
4. Create the avatar record and speech: `videodraft avatar create <portrait-url-or-file> --script "..." --voice <id> --ar 9:16`. Prefer ElevenLabs when unspecified, but honor another explicitly selected supported voice/provider.
5. Render with VEED Fabric: `videodraft avatar render <avatar_video_id> --resolution 720p`.

The portrait is passed as the avatar's character image, not as a generic video's start frame. Prefer rendering directly at 720p. Use 480p only when the user prioritizes lower cost. Avatar script generation and `avatar create` (including speech) are bundled/free. Confirm the Fabric render cost, plus portrait generation or upscaling when needed.

Direct Fabric text/audio and Sync Labs do not use the managed avatar record. The CLI uploads local portrait, video, and audio files automatically. `avatar fabric --speed fast` applies only to audio mode. Sync costs 5 credits per verified audio second; under Fal BYOK, `sync_mode` remains available but `temperature` and `active_speaker` are ignored by the provider.

### Upscaling / enhancement

- **Images**: Topaz via `videodraft upscale image <url-or-file> --scale 1x|2x|4x`. Use 1x for light enhancement without enlargement, 2x as the general default, and 4x only when the source quality and target size justify it. The result is synchronous.
- **Videos**: Topaz via `videodraft upscale video <url-or-file> --scale 2x`. Use 2x by default. The job is asynchronous; the CLI waits by default, while MCP callers poll `check_generation_status`. MCP video input must be VideoDraft-hosted, so upload local or external sources first.
- Use upscaling to preserve the image/video while improving detail, resolution, or cleanup. It cannot fix the wrong subject, misspelled text, bad framing, unwanted objects, broken continuity, or incorrect motion. Use an edit or regeneration for those problems.
- For a new Fabric avatar, render directly at 720p instead of rendering at 480p and then upscaling. Upscale the source portrait first only when the portrait itself is low quality.

## Capability gotchas

- Each model's `inputs` block is authoritative: supported `aspect_ratios`, `resolutions`, `quality_options`, `start_frame`/`end_frame`, `max_reference_images/videos/audio`, `multi_prompt`, `audio_toggle`. Passing an unsupported input fails with a clear error — check first, don't trial-and-error paid calls.
- Most video models support only 16:9 / 9:16 / 1:1. A 3:4 request hard-fails on most.
- `--seed` reproduces a specific output on models that support it (e.g. Flux, Ideogram V4); everything else ignores it. You do not need a seed for variation — `--num` already varies.
- `--rendering-speed` applies to Ideogram (V3: `Default`/`Turbo`/`Quality`; V4: `Turbo`/`Balanced`/`Quality`) and affects image cost — pass it to `videodraft costs ... --rendering-speed <tier>` for an accurate estimate. Always trust `videodraft models image --json` over this list; new models and tiers appear there the moment the platform ships them, with no CLI update.
- `seedream-v5-pro` supports unified text-to-image and reference-image editing with up to 10 image references. Use `--resolution 1K` for 7 credits/image or `--resolution 2K` for 14 credits/image.
- Reference inputs: `--ref <img>` (images, including up to 7 for Grok 1.5), `--ref-video <v>` (Gemini Omni Flash, MiniMax H3, Seedance 2, Wan 2.7), `--ref-audio <a>` (MiniMax H3, Seedance 2). The CLI uploads local files for all of these, so you can pass a path or a URL. For an exact MiniMax H3 pre-upload estimate, add `--ref-video-seconds <combined-seconds>`; the server measures actual duration before charging a real job. `--segment "<prompt>:<seconds>"` (repeatable) drives multi-prompt models (Kling 3.0 / 3.0 Turbo / O3); total 3-15s. `generate image --video-ref` is the nano-banana-2 video reference.
- The top-level prompt is OPTIONAL for `generate video` with multi-prompt models and for Kling 3.0 Turbo (`--model kling-v3-turbo`) image-to-video — a `--segment`-only or `--start-image`-only call is valid. Every other model still needs a prompt; the server enforces per-model rules.
- Hosted AI Production fallback: `videodraft produce <project> --mode full_video` generates one Seedance 2 video per scene; poll with `videodraft generations`, then `videodraft finalize <project>` swaps them into the hosted timeline before `export`. In VideoDraft ADE, do not choose this path while `videodraft_editor` is available unless the user explicitly requests hosted production. Generate or download the scene assets, import them, and assemble/export with the native editor instead. If the user explicitly requests another compatible video model for a hosted production, do not use this fixed Seedance path; generate the project shots manually with the requested model and attach them to the hosted timeline.

## Cost model

- Images: per image (× `--num`). Matrix-priced models (GPT-Image, Nano Banana Pro, Seedream v5 Pro) vary by resolution/quality.
- Video: usually credits/second × duration; rate depends on model + resolution + quality + native audio on/off.
- MiniMax H3: 26 credits/output second. The first 5 reference images are included, then 8 credits for each additional image. Reference video adds 26 credits/input second; reference audio is included.
- Grok Imagine Video 1.5: 8 credits/output second at 480p, 14 at 720p, or 25 at 1080p, plus 1 credit for each first-frame or reference image. Native generated audio is part of every output.
- Shot-image batches: one image per shot (+1 grid image per scene in `--grid` mode) — the largest single spend in the pipeline.
- VEED Fabric avatar renders: ~10 credits/sec at 480p, ~20/sec at 720p. Avatar creation and its speech are bundled/free; only optional portrait generation/upscaling adds cost before the render.
- Direct VEED Fabric: text or normal audio is 8 credits/sec at 480p and 15/sec at 720p; fast audio is 10/sec at 480p and 20/sec at 720p.
- Sync Labs Lipsync 2: 5 credits per verified audio second.
- Voiceover TTS: 10 credits per 1000 characters for standard voices, 30 per 1000 for cloned `custom-*` voices (min 1, pro-rated); applies to standalone voiceovers AND per-scene narration during `produce`. Silent tracks are free. Voice cloning itself is a flat 150 credits per clone.
- Lyria music: flat per track, 10 credits (clip) / 15 credits (pro).
- Seed Audio 1.0: 19 credits per actual output minute, prorated and rounded up to a whole credit. VideoDraft reserves the 120-second maximum of 38 credits and refunds the unused portion after generation. Fal BYOK is free.
- ElevenLabs audio: sound effects are per second, dialogue is per character, music/voice-changer/dubbing are per started minute. Voice changer and dubbing reject source media above 300s in the current synchronous flow.
- Upscales: priced by scale and source size.

Quote before spending:

```bash
videodraft costs gemini-omni-flash --type video --duration 8 --resolution 720p --audio
videodraft costs minimax-h3 --type video --duration 10 --ref-images 7 --ref-video-seconds 5
videodraft costs grok-imagine-video-1.5 --type video --duration 8 --resolution 720p --ref-images 4
videodraft costs seedance-2 --type video --duration 15 --resolution 720p --quality standard --audio
videodraft costs elevenlabs-dubbing --type audio --duration 60
videodraft costs seed-audio-1.0 --type audio --duration 60 # scenario only; model controls actual length
videodraft costs elevenlabs-dialogue --type audio --chars 350
videodraft costs voiceover --type audio --chars 800    # TTS: 10 cr / 1000 chars
videodraft generate video "..." --model gemini-omni-flash --estimate # same quote, inline
```
