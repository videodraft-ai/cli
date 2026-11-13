# Cloud render: Blender scenes on a cloud GPU

Cloud render renders the user's own `.blend` scene on cloud GPUs (NVIDIA RTX PRO 6000). Every job gets its own machine, so several jobs render at the same time; a machine starts on demand, takes the user's next job of its size when one is waiting, and switches itself off 1 minute after its last job. Waiting for a GPU is never billed. It generates nothing. Build or change the scene in Blender itself (in VideoDraft ADE, the `blender` app guide covers that); Cloud render only renders a saved file.

## Commands

```bash
videodraft render prices                          # live price per GPU-minute for each GPU size
videodraft render blender scene.blend --frames 1-240
videodraft render blender scene.blend --frames 1-240 --blender 4.5 --out ./media/renders/ --json
videodraft render blender scene.blend --frames 1001-1500 --name "S4 final" --no-wait --json
videodraft render wait "S4 final" --out ./media/renders/   # a job id works everywhere a name does
videodraft render status "S4 final" --json
videodraft render list --limit 10                  # names, status, cost, and what each machine is doing
videodraft render list --name "S4 final"
videodraft render cancel JOB_ID
videodraft render resume JOB_ID
videodraft render machine                          # each machine's phase, what you pay now, 24 h and all-time spend
videodraft render stop                             # switch every GPU off now
```

`render blender` flags:

- `--frames <first>-<last>` (required): the inclusive frame range, or one frame such as `--frames 42`.
- `--name <label>`: what to call the job, up to 80 characters (default: the scene's file name and the frames, such as `main_v8 845-1350`). `render status`, `wait`, `cancel` and `resume` accept the name instead of the job id (the newest job with it; cancel and resume refuse when two jobs of that name qualify), and `render list --name` finds them. Name each job after its shot or purpose and you never need your own file of job ids.
- `--fps <n>`: frame rate of the output MP4 (default: the scene's own).
- `--chunk <n>`: frames per segment. Segments render in order, and finished ones are kept when a job pauses, fails or is cancelled.
- `--procs <n>`: Blender processes running in parallel on the GPU, 1-4.
- `--blender 5.2|4.5`: Blender version (default 5.2).
- `--gpu full|half|quarter`: GPU size (default `full`). See [Choosing a GPU size](#choosing-a-gpu-size).
- `--out <dir|file.mp4>`: where the clip goes (default `media/renders/<job_id>.mp4`).
- `--no-wait`: submit, print the job id and return. Resume with `videodraft render wait <job_id>`.

## What the CLI does

1. Hashes the file (SHA-256). A scene with the same bytes is uploaded only once, so re-rendering other frames skips the upload.
2. Uploads a new scene to its upload session in resumable 64 MiB chunks; after a dropped connection it asks the session what arrived and continues from there.
3. Submits the job. It waits for Google to hand over a GPU: usually 1 to 10 minutes, 15 or more at busy times. This wait is not billed, and the job keeps its place in the queue.
4. Polls every 10 seconds with no time limit (renders can take hours), printing each change: `waiting for a free GPU (not billed)`, `GPU found, starting up`, `rendering (2/4 segments)`. After 5 minutes without a GPU it says once that this is normal. `--wait-timeout` and `--wait-interval` still apply when given.
5. Downloads the finished MP4, then says what the job cost and where the billed time went, for example `Billed 2m 18s of GPU time (start-up 15s, rendering 38s, idle before switch-off 1m 25s). Waited 8m 19s for a GPU, not billed.`

`--json` prints one document: the job (`job_id`, `name`, `status`, `message`, `wait_seconds`, `segments_done`, `segments_total`, `timing`, `cost`, `clip_url`) plus `scene_sha`, `uploaded` and `downloaded_files`. With `--no-wait` it is the submitted job: `job_id`, `name`, `status`, `message`, `machine`, `credits_per_minute` and `segments`.

Exit codes: 0 done; 1 failed, cancelled or another error; 2 bad flags; 3 not signed in; 4 out of credits. Code 4 comes either before the job starts (the balance is below the minimum a job needs) or mid-render: the job pauses, keeps its finished segments, and waits. Tell the user, and after they add credits run `videodraft render resume <job_id>`. A failed job carries its error; `render resume` retries its unfinished segments, but fix the scene first when the error points at it.

## Choosing a GPU size

`videodraft render prices` lists the sizes on offer and each one's rate:

| `--gpu`                  | GPU memory | Speed   | Cost per frame               |
| ------------------------ | ---------- | ------- | ---------------------------- |
| `full` (default)         | 96 GB      | fastest | highest                      |
| `half` (when offered)    | 48 GB      | slower  | lower                        |
| `quarter` (when offered) | 24 GB      | slowest | lowest, most of all on Eevee |

All bill per second. A smaller GPU is cheaper overall, not just per minute, because one render rarely uses a whole RTX PRO 6000. Use `full` when the user is waiting, has a deadline or the scene is heavy; a smaller size when they want it cheaper and are not in a hurry. The scene has to fit in the GPU memory: if a render fails for memory, run it again on a bigger size. `render status` shows a job's cost so far and, while it renders, an estimate for the whole job.

## Scenes must be self-contained

Pack external files before rendering: in Blender, File > External Data > Pack Resources, then save. Linked libraries, simulation caches and images outside the `.blend` are missing on the machine, and the machine has no internet. Blender runs in background mode with auto-run off, so scripts and drivers that need Python inside the file do not run.

## Cost and machine time

What a job is billed for, at its GPU size's rate from `videodraft render prices` (MCP `cloud_render_prices`), per second:

| Part                                         | Billed | Typical                                                                                                 |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Waiting for Google to hand over a GPU        | **No** | 1 to 10 minutes; 15 or more at busy times                                                               |
| Start-up, once Google hands the machine over | Yes    | about 15 seconds, only on a machine's first job                                                         |
| Rendering                                    | Yes    | the frames                                                                                              |
| Idle wait and power-off after the job        | Yes    | about 85 seconds, only when no job of its size is waiting; a waiting job takes the machine over at once |

Each start has a one-minute minimum. So a short test job costs only a few credits, mostly its minute of start-up and idle time, and test renders, proofs and previews belong in the cloud as much as finals. Submit all the jobs you have at once: each gets its own machine, and jobs that wait for the same GPU size take over finished machines with no start-up or idle time.

`render status` and `render wait` show the split: `waited` (not billed), then `billed` as start-up, rendering and idle. A job's cost can still grow for about a minute after it is done, while its machine waits for more work; `cost.final` says when it is settled, and until then `cost.estimated_total_credits` says what it will be. `render machine` shows what each machine is doing: `waiting for a GPU (not billed)`, `starting up`, `rendering`, `idle` or `switching off`, and `billing now` adds up only the machines Google has handed over.

Waiting for a GPU is free. A queued job may also have a machine starting, which is billed, or charges from an earlier attempt; check its phase and cost. If a GPU takes long, say Google is short of GPUs at the moment and the job keeps its place.

Uploading and starting need a minimum balance; when only about two minutes of credit are left, every machine stops and the jobs pause. State the rate and get a go-ahead before long renders. When your task is finished, run `videodraft render stop` so idle time is not billed, unless the user still has renders queued.

Never submit the same render twice to recover from a lost wait or a timeout: the first job keeps running and billing. Check `videodraft render list` (or `render list --name <name>`) and continue with `render wait`.

## Without the CLI (MCP)

1. `cloud_render_upload_scene` with the file's `sha256` and `size`. `exists: true` means skip to step 3.
2. PUT the bytes to `upload_url`: one PUT of the whole file, or chunks that are multiples of 256 KiB with `Content-Range: bytes <first>-<last>/<size>` (308 means send the next chunk from the Range header, 200 or 201 means complete). Then `cloud_render_finalize_scene` with the same `sha256`.
3. `cloud_render_submit` with `scene_sha`, `start`, `end` and optional `name`, `gpu`, `fps`, `chunk`, `procs`, `blender_version`.
4. Poll `cloud_render_status` every 10 seconds or more. `message` and `machine.phase` distinguish a free GPU wait from billable start-up; `wait_seconds` gives the free wait when known. `clip_url` is the finished MP4; `segment_urls` lists finished pieces before then; `cost` has the credits so far, `start_up_seconds`, `render_seconds` and `idle_seconds`, and `estimated_total_credits` (plus `estimated_minutes_left` while rendering).
5. `cloud_render_stop` when the work is done. `cloud_render_list` (with `name` to find jobs by name), `cloud_render_cancel`, `cloud_render_resume` and `cloud_render_machine` (each machine's `phase` and `billing`) match the CLI commands above.
