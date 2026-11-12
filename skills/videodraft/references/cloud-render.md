# Cloud render: Blender scenes on a cloud GPU

Cloud render renders the user's own `.blend` scene on a cloud GPU: one machine per user (an RTX PRO 6000) that starts on demand, renders that user's jobs one after another, and switches itself off 2 minutes after its last job. It generates nothing. Build or change the scene in Blender itself (in VideoDraft ADE, the `blender` app guide covers that); Cloud render only renders a saved file. It needs a paid plan or a past credit purchase; other accounts are refused with an upgrade message, which you relay instead of retrying.

## Commands

```bash
videodraft render prices                          # live price per GPU-minute, GPU and machine type
videodraft render blender scene.blend --frames 1-240
videodraft render blender scene.blend --frames 1-240 --fps 24 --blender 4.5 --out ./media/renders/ --json
videodraft render blender scene.blend --frames 1001-1500 --no-wait --json
videodraft render wait JOB_ID --out ./media/renders/
videodraft render status JOB_ID --json
videodraft render list --limit 10
videodraft render cancel JOB_ID
videodraft render resume JOB_ID
videodraft render machine                          # state, billed time, GPU time used today
videodraft render stop                             # switch the GPU off now
```

`render blender` flags:

- `--frames <first>-<last>` (required): the inclusive frame range, or one frame such as `--frames 42`.
- `--fps <n>`: frame rate of the output MP4 (default 30).
- `--chunk <n>`: frames per segment. Segments render in order, and finished ones are kept when a job pauses, fails or is cancelled.
- `--procs <n>`: Blender processes running in parallel on the GPU, 1-4.
- `--blender 5.2|4.5`: Blender version (default 5.2).
- `--out <dir|file.mp4>`: where the clip goes (default `media/renders/<job_id>.mp4`).
- `--no-wait`: submit, print the job id and return. Resume with `videodraft render wait <job_id>`.

## What the CLI does

1. Hashes the file (SHA-256). A scene with the same bytes is uploaded only once, so re-rendering other frames skips the upload.
2. Uploads a new scene to its upload session in resumable 64 MiB chunks; after a dropped connection it asks the session what arrived and continues from there.
3. Submits the job. The machine starts on demand, which can take a few minutes while a GPU is found.
4. Polls every 10 seconds with no time limit (renders can take hours), printing each status change and the segments done. `--wait-timeout` and `--wait-interval` still apply when given.
5. Downloads the finished MP4.

`--json` prints one document: the job (`job_id`, `status`, `segments_done`, `segments_total`, `timing`, `clip_url`) plus `scene_sha`, `uploaded` and `downloaded_files`. With `--no-wait` it is the submitted job: `job_id`, `status`, `machine`, `credits_per_minute` and `segments`.

Exit codes: 0 done; 1 failed, cancelled or another error; 2 bad flags; 3 not signed in; 4 out of credits. Code 4 comes either before the job starts (the balance is below the minimum a job needs) or mid-render: the job pauses, keeps its finished segments, and waits. Tell the user, and after they add credits run `videodraft render resume <job_id>`. A failed job carries its error; `render resume` retries its unfinished segments, but fix the scene first when the error points at it.

## Scenes must be self-contained

Pack external files before rendering: in Blender, File > External Data > Pack Resources, then save. Linked libraries, simulation caches and images outside the `.blend` are missing on the machine, and the machine has no internet. Blender runs in background mode with auto-run off, so scripts and drivers that need Python inside the file do not run.

## Cost and machine time

The GPU bills per second while it is on, at the rate `videodraft render prices` (MCP `cloud_render_prices`) returns, with a one-minute minimum each time it starts. That includes start-up and the idle minutes before it switches itself off. State the rate and get a go-ahead before long renders. When your task is finished, run `videodraft render stop` so idle time is not billed, unless the user still has renders queued. A daily GPU-time limit applies; `videodraft render machine` shows the time used and the limit.

Never submit the same render twice to recover from a lost wait or a timeout: the first job keeps running and billing. Check `videodraft render list` and continue with `render wait`.

## Without the CLI (MCP)

1. `cloud_render_upload_scene` with the file's `sha256` and `size`. `exists: true` means skip to step 3.
2. PUT the bytes to `upload_url`: one PUT of the whole file, or chunks that are multiples of 256 KiB with `Content-Range: bytes <first>-<last>/<size>` (308 means send the next chunk from the Range header, 200 or 201 means complete). Then `cloud_render_finalize_scene` with the same `sha256`.
3. `cloud_render_submit` with `scene_sha`, `start`, `end` and optional `fps`, `chunk`, `procs`, `blender_version`.
4. Poll `cloud_render_status` every 10 seconds or more. `clip_url` is the finished MP4; `segment_urls` lists finished pieces before then.
5. `cloud_render_stop` when the work is done. `cloud_render_list`, `cloud_render_cancel`, `cloud_render_resume` and `cloud_render_machine` match the CLI commands above.
