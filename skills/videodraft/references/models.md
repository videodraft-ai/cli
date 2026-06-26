# Choosing models (and predicting cost)

Always consult the live catalog instead of memorizing this page — models change weekly:

```bash
videodraft models image --json     # every image model + inputs (aspect ratios, resolutions, max refs)
videodraft models video --json     # every video model + inputs + per-second pricing metadata
videodraft models audio --json     # standalone audio/media models + pricing inputs
videodraft models voices --json    # TTS voices
videodraft models styles --json    # visual style presets
```

## Defaults (safe starting points)

- **Image**: `nano-banana-2` (the platform default, 1K). Use `--num 1..4` for variations of one prompt in a single call — never loop for variations.
- **Video**: `google-veo3.1` at fast quality (6s / 720p) — the platform default.
- **Voiceover**: ElevenLabs Brittney (default voice).
- **Music**: `lyria-3-clip-preview` (30s, cheap); `lyria-3-pro-preview` for 180s/quality; `elevenlabs-music` for music that can include vocals/lyrics.
- **ElevenLabs audio**: `generate sound-effect`, `generate dialogue`, `generate voice-changer`, and `generate dub` are synchronous audio/media calls. Voice changer and dubbing require the source media duration in seconds for billing and currently accept source media up to 300s.

## Capability gotchas

- Each model's `inputs` block is authoritative: supported `aspect_ratios`, `resolutions`, `quality_options`, `start_frame`/`end_frame`, `max_reference_images/videos/audio`, `multi_prompt`, `audio_toggle`. Passing an unsupported input fails with a clear error — check first, don't trial-and-error paid calls.
- Most video models support only 16:9 / 9:16 / 1:1. A 3:4 request hard-fails on most.
- `--seed` reproduces a specific output on models that support it (e.g. Flux, Ideogram V4); everything else ignores it. You do not need a seed for variation — `--num` already varies.
- `--rendering-speed` applies to Ideogram (V3: `Default`/`Turbo`/`Quality`; V4: `Turbo`/`Balanced`/`Quality`) and affects image cost — pass it to `videodraft costs ... --rendering-speed <tier>` for an accurate estimate. Always trust `videodraft models image --json` over this list; new models and tiers appear there the moment the platform ships them, with no CLI update.
- Reference inputs: `--ref <img>` (images), `--ref-video <v>` (Seedance 2, Wan 2.7), `--ref-audio <a>` (Seedance 2). The CLI uploads local files for all of these, so you can pass a path or a URL. `--segment "<prompt>:<seconds>"` (repeatable) drives multi-prompt models (Kling 3.0 / 3.0 Turbo / O3); total 3-15s. `generate image --video-ref` is the nano-banana-2 video reference.
- The top-level prompt is OPTIONAL for `generate video` with multi-prompt models and for Kling 3.0 Turbo (`--model kling-v3-turbo`) image-to-video — a `--segment`-only or `--start-image`-only call is valid. Every other model still needs a prompt; the server enforces per-model rules.
- AI Production: `videodraft produce <project> --mode full_video` generates one Seedance 2 video per scene; poll with `videodraft generations`, then `videodraft finalize <project>` swaps them into the timeline before `export`.

## Cost model

- Images: per image (× `--num`). Matrix-priced models (GPT-Image, Nano Banana Pro) vary by resolution/quality.
- Video: usually credits/second × duration; rate depends on model + resolution + quality + native audio on/off.
- Shot-image batches: one image per shot (+1 grid image per scene in `--grid` mode) — the largest single spend in the pipeline.
- Avatar renders: ~10 credits/sec at 480p, ~20/sec at 720p.
- ElevenLabs audio: sound effects are per second, dialogue is per character, music/voice-changer/dubbing are per started minute. Voice changer and dubbing reject source media above 300s in the current synchronous flow.
- Upscales: priced by scale and source size.

Quote before spending:

```bash
videodraft costs google-veo3.1 --type video --duration 8 --resolution 1080p --audio
videodraft costs elevenlabs-dubbing --type audio --duration 60
videodraft costs elevenlabs-dialogue --type audio --chars 350
videodraft generate video "..." --estimate        # same quote, inline
videodraft credits                                 # current balance
```
