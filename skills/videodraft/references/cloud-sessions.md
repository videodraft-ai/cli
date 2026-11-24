# Cloud sessions: a GPU machine to work on

A Cloud session is a cloud GPU machine (NVIDIA RTX PRO 6000) that you work on for a while: push files once, run shell commands and Blender scripts on it, pull results back, and render from it. Each project gets its own session, so several projects run at the same time without waiting on one local Blender.

## Which to use

- **This computer's Blender**: quick edits and anything the user wants to watch or adjust in the Blender window.
- **A Cloud session**: building or changing scenes with scripts, look-dev stills, proofs, many short Blender runs, and several projects at once.
- **A Cloud render job** (`render session blender`, or `render blender` for a local file): the final frames, each job on its own GPU.

Cloud sessions and render jobs spend VideoDraft credits: state the rate (`videodraft render prices`) and get a go-ahead before the first one, as for renders.

## Commands

```bash
videodraft render session start --name film76 --no-wait      # returns at once; the GPU wait is not billed
videodraft render session push film76 blender scripts --to project   # upload while it starts
videodraft render session run film76 --cwd project "blender -b --factory-startup --python-exit-code 1 --python scripts/build.py && blender -b scene.blend --python-exit-code 1 --python scripts/stills.py"   # waits for the machine
videodraft render session pull film76 project/stills --out media/stills   # the stills land straight in media/stills
videodraft render session blender film76 project/scene.blend --frames 1-120 --name "film76 1-120" --no-wait
videodraft render session blender film76 project/scene.blend --frames 121-240 --name "film76 121-240" --no-wait
videodraft render session pause film76                       # the render jobs do not need it; or release it
videodraft render wait "film76 1-120" --out media/renders/  # then the other range
videodraft render session snapshot film76 film76-v3          # a named copy of its files, kept 30 days
videodraft render session start --name film76b --from-snapshot film76-v3
videodraft render session release film76                     # its files stay 30 days
videodraft render session delete film76                      # or free them now
videodraft render session status film76
videodraft render session list                               # every session, and storage used of the cap
```

`start` flags: `--name` (use it everywhere instead of the id; give each project its own), `--gpu full|half|quarter` (below), `--from-snapshot <name>`, `--idle-minutes <n>` (1 to 1440, default 15), `--budget <credits>` (pauses the session at that cost; saving and switching off add about a minute), `--no-spot`, `--no-wait`. Without `--no-wait`, `start` waits until the machine is ready.

## GPU size

| `--gpu`          | GPU memory | Rate (`render prices`) | Good for                                                    |
| ---------------- | ---------- | ---------------------- | ----------------------------------------------------------- |
| `full` (default) | 96 GB      | highest                | heavy scenes, full-size stills, anything the user waits for |
| `half`           | 48 GB      | about 58% of full      | most scene building, look-dev and proofs                    |
| `quarter`        | 24 GB      | about 29% of full      | scripts, small stills and proofs that fit 24 GB             |

A session keeps its size: every machine it starts on, after a pause too, has the same GPU. For another size, start another session (`--from-snapshot` to bring the files). Its final frames can still render on any size: `render session blender --gpu`. On a half or quarter, run heavy Blender commands one at a time: commands share the GPU's memory.

## How it works

- **Billing.** Per second from the moment Google hands the machine over, at the Cloud render rate of the session's size plus about a cent an hour for its bigger disk (the `session credits/min` column of `render prices`), with at least a minute per start. Start-up (booting and loading the session's files) takes about 1 to 2 minutes before the session is ready and is billed; the status can still say "waiting" for part of it. Waiting for a GPU is not billed, and neither is a paused session. A session asks for a regular GPU and, after about 2 minutes without one, a Spot GPU of its size too, at Google's own Spot price where it lands, never more than the regular rate (`--no-spot` waits for a regular one); `status` says "on Spot" when it got one, and "billing now" shows the machine's rate. Google can take a Spot machine back at any time: the session then pauses with what finished commands saved (a running command is cut off), and the next `run` resumes it.
- **Idle pause.** A session pauses itself after its idle minutes: billing stops, its files stay saved, and `resume` or the next `run` starts it on a new machine with them.
- **Files.** `push` sends files and folders by content: unchanged files are never uploaded again. A folder keeps its name under `--to` (`push s blender --to project` makes `project/blender/...`); a file lands as `--to/<file name>`. Pushes go to storage, not the machine, so they work while the session starts or is paused: start with `--no-wait` and push during the GPU wait. Commands start once the machine has the current files. `pull <folder>` puts that folder's files straight into `--out`; without a folder, everything comes with its session path.
- **The machine.** Linux with Blender 5.2 as `blender` (`$BLENDER`) and 4.5 as `$BLENDER_4_5`; Python 3 with NumPy, SciPy, OpenCV, Pillow and imageio; FFmpeg, ImageMagick, OpenEXR tools, git, curl, wget, 7-Zip, jq and common fonts. It reaches the web over HTTP and HTTPS, so scripts can download assets and `pip install --user` packages directly (much faster than pushing them from this computer). Commands run as a restricted user: no admin rights (no `apt`), and no access to the machine's credentials. Up to about 20 GB may be sent out to the internet per machine start; downloads are not counted.
- **The home folder.** Commands run with `HOME` in the session's `.home` folder, so what they install there (`pip install --user`, tools in `~/.local/bin`, Blender add-ons) is saved with the session, kept through pauses and snapshots. Caches are not saved. `pull` leaves `.home` out unless you name it.
- **Blender.** Run `blender -b --factory-startup --python-exit-code 1 --python script.py`: without `--python-exit-code 1`, a failing script still exits 0. `--factory-startup` resets the GPU settings, so every render script turns the GPU on itself:

  ```python
  prefs = bpy.context.preferences.addons["cycles"].preferences
  prefs.compute_device_type = "OPTIX"
  prefs.get_devices()
  for d in prefs.devices:
      d.use = d.type == "OPTIX"
  bpy.context.scene.cycles.device = "GPU"
  ```

  Ignore Blender's `HIPEW initialization failed` warning; the GPU is NVIDIA.
- **Commands.** Up to 3 run at once. Each `run` takes about 20 to 25 s around the command itself (the first one after a start can take longer, while the machine loads the files), so chain short steps in one `run` with `&&`. `run` streams the output every few seconds (Python prints show sooner with `print(..., flush=True)`) and resumes a paused session first (`--no-resume` fails instead). `--detach` returns a command id for `logs <session> <id> [--follow]`; `--timeout <s>` stops a long one. A failed command makes `run` exit 1; the command's own exit code is in the output.
- **Saving.** What a command changes is saved when it ends; `sync` saves while something still runs. `pull`, `blender`, `scene` and `snapshot` see saved files only. Links (symlinks) are not saved.
- **Final renders.** `render session blender <session> <path> --frames a-b` renders a saved `.blend` from the session as a Cloud render job, with no upload from this computer; it takes `--name`, `--gpu`, `--procs`, `--blender`, `--no-spot`, `--out` and `--no-wait` (`--json` works on every command). Like `render blender`, it renders that one file on the GPU with OptiX, so pack textures and other files into it first (`bpy.ops.file.pack_all()`) and make linked libraries local. Each job bills its own start-up (about 15 to 20 s) and about a minute and a half of idle before its machine switches off, so split a film into ranges only when each range takes several minutes: time a 50% still in the session to estimate the full-size frame time. Once the jobs are submitted, pause or release the session: they do not need it. `render session scene <session> <path>` prints a saved `.blend`'s `scene_sha` for MCP `cloud_render_submit`; a paused or released session works too, and so does `snapshot` (within its 30 days).
- **Storage.** Each account has a storage cap for session files, snapshots and files kept after release; `session list` shows it. A push, start or resume past it is refused: `delete` sessions you no longer need, or delete snapshots (`snapshot-delete`). Files a snapshot also holds stay counted until the snapshot is deleted. A running or paused session keeps its files; a session paused 90 days without use is released, and a released session's files stay 30 days.
- **Other agents.** Sessions are separated only by name; `session list` shows every session on the account, and `render list` every render job (name your jobs, so you can tell yours apart). `render stop` switches off every machine on the account, other agents' sessions and jobs included (sessions save first): run it only when the user asks.

MCP: the same operations are the tools `cloud_session`, `cloud_session_files`, `cloud_session_command` and `cloud_session_snapshot`.
