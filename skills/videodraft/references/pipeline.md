# VideoDraft pipeline reference

Everything here works through the CLI (`videodraft <command>` / `videodraft call <tool>`) or the MCP connector (tool names in backticks). One backend; pick the surface you have.

Use direct asset tools for standalone images, clips, audio, upscales, and descriptions. Use a project for any multi-scene video, story, ad, explainer, storyboard, editable timeline, or final export even when the request does not use the word "project." Script-only uses a script-stage project and stops at the script.

## Stages and their tools

| Stage                                   | CLI                                                                         | Underlying tool                            |
| --------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| Idea → full storyboard project          | `videodraft create "<idea>"`                                                | `generate_storyboard_from_idea`            |
| Idea → script only (stop there)         | `videodraft create "<idea>" --script-only`                                  | `generate_script_from_idea`                |
| Footage IS the video                    | `videodraft call generate_storyboard_from_media`                            | `generate_storyboard_from_media`           |
| Batch shot images                       | `videodraft shots <project>`                                                | `generate_shot_images`                     |
| One shot image                          | `videodraft generate image --project <id> --scene N --shot M`               | `generate_image`                           |
| Produce (voiceover, captions, timeline) | `videodraft produce <project>`                                              | `produce_project`                          |
| Per-shot motion prompts                 | `videodraft video-prompts <project>`                                        | `generate_video_prompts`                   |
| Motion clip for a shot                  | `videodraft generate video --project <id>`                                  | `generate_video`                           |
| Attach a finished clip to the timeline  | `videodraft attach <project> --scene N --shot M --media <url> --type video` | `attach_media_to_shot`                     |
| Background music                        | `videodraft generate music --attach <project>`                              | `generate_music` / `set_background_music`  |
| General or reference-driven audio       | `videodraft generate audio "..."`                                          | `generate_audio`                           |
| Sound effect                            | `videodraft generate sound-effect "..."`                                    | `generate_sound_effect`                    |
| Dialogue audio                          | `videodraft generate dialogue --line "voice:text"`                          | `generate_dialogue`                        |
| Voice changer                           | `videodraft generate voice-changer <audio>`                                 | `change_voice`                             |
| Dubbing                                 | `videodraft generate dub <audio_or_video>`                                  | `dub_media`                                |
| Scene voiceover                         | `videodraft generate voiceover --project <id> --scene N`                    | `generate_voiceover`                       |
| Avatar script                           | `videodraft avatar script "<idea>"`                                         | `generate_avatar_script`                   |
| Avatar + speech                         | `videodraft avatar create <portrait> --script "..."`                        | `create_avatar_video`                      |
| Talking-head render                     | `videodraft avatar render <avatar_video_id>`                                | `render_avatar_video` + `get_avatar_video` |
| Direct portrait + text/audio            | `videodraft avatar fabric <portrait> --text "..."` or `--audio <file>`      | `generate_veed_fabric_video`               |
| Existing video + replacement audio      | `videodraft avatar lipsync <video> --audio <file>`                          | `generate_sync_lipsync_video`              |
| Existing-video AI edit                  | `videodraft edit video <video> "<change>" --model <video-edit-model>`       | `edit_video`                               |
| Motion transfer                         | `videodraft edit motion <image> "<direction>" --motion-video <video>`       | `generate_motion_control_video`            |
| Image enhancement/upscale               | `videodraft upscale image <image>`                                          | `upscale_image`                            |
| Video enhancement/upscale               | `videodraft upscale video <video>`                                          | `upscale_video`                            |
| Final MP4                               | `videodraft export <project>`                                               | `export_video` + `check_export_status`     |

## Rules that prevent broken results

- **The storyboard is generated FROM the script**, never from the raw idea. `videodraft create` runs the whole chain correctly. Don't call `generate_storyboard_scenes` with a raw idea as the "script".
- **Visual consistency**: never generate a storyboard shot in isolation. Shot prompts carry `[[asset:Name]]` / `[[shot:X-Y]]` tags that `generate_shot_images` resolves against the project's visual assets and prior shots. When generating a single shot whose prompt has no tags, pass `--ref` images yourself (the project's visual assets and/or the previous shot's image; `projects get` exposes both). For scenes with multiple shots or recurring characters, prefer `videodraft shots <project> --model <selected-image-model> --grid`: preserve an explicitly requested compatible image model, otherwise use `nano-banana-2`. It creates one coherent scene grid, then decodes it into individual shot images.
- **Reference-first video**: when identity, styling, or composition matters, do not generate each motion clip from text alone. Generate or select the shot still first, then pass the decoded shot image as `--start-image` or `--ref` to the selected video model. AI Production already composes scene grids and sends them to Seedance as references. If the user explicitly requests another compatible video model, bypass fixed Seedance full-video mode and generate the per-shot clips with the requested model, using the individual decoded shot images as anchors.
- **Hold off generating shot images while the user is still iterating** on storyboard structure.
- **produce → export ordering**: `export` requires a produced project where every production scene has timeline media. If `produce` returns `generating_shot_images`, poll the job ids it returns, then re-run produce.
- **Generated motion clips do not auto-attach**: after `generate video` completes, attach the clip with `attach_media_to_shot` (`media_type:"video"`, include `duration_seconds`) — it replaces the production timeline clip while keeping the storyboard still.
- **Talking heads use dedicated avatar tools**: do not use `generate video`. Use managed `avatar create` and `avatar render` for reusable avatars, direct `avatar fabric` for a portrait plus text/audio, and `avatar lipsync` for an existing video plus replacement audio. Reuse a supplied person image or generate a clear front-facing portrait with the explicitly requested compatible image model, otherwise Nano Banana 2. Managed avatar creation and speech are bundled/free; direct Fabric, Sync, and render are paid.
- **Existing-video edits use their own category**: call `edit_video` or `videodraft edit video` with a `video_edit` model when transforming the source itself. Kling O3 and Wan 2.7 Ref/Edit are dual-mode: their reference-generation modes may use generic `generate_video` to create a new guided clip. Motion transfer similarly uses `generate_motion_control_video` or `videodraft edit motion` with a `motion_control` model.
- **Upscaling preserves rather than redesigns**: use Topaz when resolution, detail, or cleanup is the problem. Regenerate or edit when the subject, text, framing, continuity, or motion is wrong. Upscale a low-quality avatar portrait before Fabric; do not render a new avatar at 480p just to upscale the result.
- **Timeouts on the one-shot create**: if `create` times out at the transport layer, the project was still created server-side — `videodraft projects list`, take the most recent, and resume with its id. Don't start a duplicate.

## User-attached media: classify roles first

For EACH attached file decide:

- **visual_asset** — recurring reference (character / product / location / style). Upload, then pass in `visual_assets` of `generate_storyboard_from_idea` (via `videodraft call`), or add to an existing project with `add_visual_assets`. Type must be one of `character | object | location | style | custom` with a short name + concrete description.
- **shot** — the media IS footage for the video. Whole video = footage → `generate_storyboard_from_media`. Idea + footage → `generate_storyboard_from_idea` with `shot_media`. Existing storyboard → `attach_media_to_shots`.
- **reference** — inspiration only → fold a description into the idea/instructions; don't place it as a shot or asset.

Ambiguous (e.g. a person holding a product)? Ask the user.

Uploads persist in the media library — recall later with `videodraft media list`.

## Editing project data safely

1. `videodraft call get_project_schema` — read the structure once per session.
2. `videodraft projects get <id> --raw` — the exact editable blob.
3. Modify; then `videodraft call update_project --stdin` with `{"project_id": "...", "data": {...}}`.
   - Objects deep-merge key-by-key; **arrays replace wholesale** — send the complete array you're changing (e.g. all of `storyboard.scenes`).
   - Scene shot arrays (`image_prompt` / `shot_types` / `shot_actions` / `search_prompt` / `preview_media`) are auto-aligned; fix-ups come back as warnings.
4. Snapshot before risky edits: `videodraft checkpoint create <id> --name "before re-script"`. Restore with `videodraft checkpoint restore <id> <version>`.

## AI Studio sessions (standalone generations)

Project generations group automatically. For standalone work in a long conversation, create one session up front and reuse it:

```bash
SESSION=$(videodraft call create_ai_studio_session --arg name="Fox brand explorations" --json | jq -r .session_id)
videodraft generate image "..." --session "$SESSION"
```
