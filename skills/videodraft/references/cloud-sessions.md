# Cloud sessions: a GPU machine to work on

A Cloud session is a cloud GPU machine (NVIDIA RTX PRO 6000, 96 GB) that you work on for a while: push files once, run shell commands and Blender scripts on it, pull results back, and render from it. Each project gets its own session, so several projects run at the same time without waiting on one local Blender.

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

`start` flags: `--name` (use it everywhere instead of the id; give each project its own), `--from-snapshot <name>`, `--idle-minutes <n>` (1 to 1440, default 15), `--budget <credits>` (pauses the session at that cost; saving and switching off add about a minute), `--no-spot`, `--no-wait`. Without `--no-wait`, `start` waits until the machine is ready.

## How it works

- **Billing.** Per second while the machine is on, at the Cloud render rate. Waiting for a GPU is not billed, and neither is a paused session. A session asks for a regular GPU and, after about 2 minutes without one, a Spot GPU too, at the higher Spot rate (`--no-spot` waits for a regular one). Google can take a Spot machine back at any time: the session then pauses with what finished commands saved (a running command is cut off), and the next `run` resumes it.
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
- **Commands.** Up to 3 run at once. Each `run` takes about 15 s to start and 5 s to finish around the command itself, so chain short steps in one `run` with `&&`. `run` streams the output every few seconds (Python prints show sooner with `print(..., flush=True)`) and resumes a paused session first (`--no-resume` fails instead). `--detach` returns a command id for `logs <session> <id> [--follow]`; `--timeout <s>` stops a long one. A failed command makes `run` exit 1; the command's own exit code is in the output.
- **Saving.** What a command changes is saved when it ends; `sync` saves while something still runs. `pull`, `blender`, `scene` and `snapshot` see saved files only. Links (symlinks) are not saved.
- **Final renders.** `render session blender` renders a saved `.blend` from the session as a Cloud render job, with no upload from this computer. Like `render blender`, it renders that one file, so pack textures and other files into it first (`bpy.ops.file.pack_all()`) and make linked libraries local. Each job bills its own start-up and about a minute of idle after it, so split a film into ranges only when each range takes several minutes. Once the jobs are submitted, pause or release the session: they do not need it. `render session scene <session> <path>` prints a saved `.blend`'s `scene_sha` for MCP `cloud_render_submit`; a paused or released session works too.
- **Storage.** Each account has a storage cap for session files, snapshots and files kept after release; `session list` shows it. A push, start or resume past it is refused: `delete` sessions you no longer need, or delete snapshots (`snapshot-delete`). Files are kept 30 days after their last use.
- **Other agents.** Sessions are separated only by name; `session list` shows every session on the account. `render stop` switches off every machine on the account, other agents' sessions and jobs included (sessions save first): run it only when the user asks.

MCP: the same operations are the tools `cloud_session`, `cloud_session_files`, `cloud_session_command` and `cloud_session_snapshot`.
