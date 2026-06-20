# videodraft

The official [VideoDraft](https://videodraft.ai) CLI — create AI videos, images, voiceovers and music from your terminal. Built for humans **and** coding agents: every command supports `--json`, exit codes are stable, async jobs are first-class.

```bash
npx videodraft login
npx videodraft generate image "a red fox in snow, cinematic" --download ./out/
npx videodraft create "30s launch video for our espresso machine" --ar 9:16
```

## Install

```bash
npm install -g videodraft     # global: adds the `videodraft` command to your PATH
videodraft --version          # → confirms it's installed

# …or run without installing — npx fetches and runs the latest each time:
npx videodraft <command>
```

Requires Node ≥ 20.18.1. (Publishing to npm doesn't put `videodraft` on your PATH — `npm i -g` or `npx` does. A Homebrew tap and a `curl | sh` installer are on the way.)

## Authenticate

```bash
videodraft login                    # opens your browser (OAuth)
videodraft login --token vd_mcp_…   # personal access token from https://app.videodraft.ai/mcp-keys
export VIDEODRAFT_API_KEY=vd_mcp_…  # headless / CI — no login command needed
```

Credentials are stored in `~/.config/videodraft/config.json` (0600). `videodraft logout` revokes and clears them.

## The pipeline

```bash
videodraft credits                              # know your budget
videodraft create "<idea>" --ar 9:16            # idea → script → visual assets → storyboard
videodraft shots <project> --grid --estimate    # preview the cost…
videodraft shots <project> --grid               # …then batch-generate every shot image
videodraft produce <project>                    # voiceovers + captions + production timeline
videodraft export <project> --download final.mp4
```

Single assets don't need a project:

```bash
videodraft generate image "isometric workspace, warm light" --num 4 --download "./out/{job_id}_{index}.{ext}"
videodraft generate video "slow dolly over a misty lake" --model google-veo3.1 --duration 6 --estimate
videodraft generate voiceover "Welcome to VideoDraft" --download welcome.mp3
videodraft generate music "minimal ambient, 60 BPM" --download bgm.mp3
videodraft upscale image ./photo.png --scale 4x --download ./photo-4x.png
videodraft avatar create ./founder.jpg --script "$(videodraft avatar script 'our launch' --json | jq -r .script)"
```

## Commands

| Group | Commands |
|---|---|
| Auth | `login` `logout` `whoami` |
| Account | `credits` `costs [model]` `models [image\|video\|voices\|styles]` `workspaces` `sessions list/create` |
| Projects | `projects list/get/delete/favorite/open` `checkpoint create/list/restore` |
| Pipeline | `create` `shots` `produce` (`--mode full_video`) `attach` `finalize` `export` `export-status` `video-prompts` |
| Generate | `generate image/video/voiceover/music` `upscale image/video` `avatar script/create/render/get/list` |
| Jobs | `status <job>` `wait <job>` `generations` |
| Media | `upload <file>` `media list` `describe <url\|file>` `download <url>` |
| Everything else | `tools list` `tools schema <name>` `call <tool> --args '<json>'` |
| Agents | `skills install [--agent claude\|codex\|cursor]` `skills path` |
| Utility | `config get/set/path` `completion bash\|zsh` `docs` `--version` |

`call` reaches **every** VideoDraft API tool (the full MCP catalog), including ones without a curated command — new platform features work in the CLI the day they ship.

## For agents and scripts

- `--json` on any command prints a single JSON document on stdout.
- Exit codes: `0` ok · `1` error · `2` usage · `3` auth required · `4` insufficient credits.
- Async generations wait by default; `--no-wait` returns `{job_id}` immediately, `videodraft wait <job...>` resumes, `--wait-timeout 30m --wait-interval 5s` tune polling.
- **Many jobs at once?** Submit them all with `--no-wait`, then `videodraft wait <id1> <id2> ...` — one process polls every job with ONE batched request per tick (don't spawn N parallel `wait` processes). Polling backs off adaptively (3s → 15s with jitter) on long jobs unless you pin `--wait-interval`.
- `--download` templates: `{job_id}`, `{index}`, `{ext}`, `{name}`. Downloads are echoed as `downloaded_files[]` in `--json` output.
- Local file → public URL anywhere a URL is expected (`--ref photo.jpg`), or explicitly via `videodraft upload`.
- `NO_COLOR` and `--no-color` are respected; output is uncolored when piped.

Install the VideoDraft skill so your agent knows the workflow:

```bash
npx videodraft skills install                  # zero-install: npx fetches the CLI and installs the skill
videodraft skills install                      # if the CLI is on PATH — auto-detects your installed agents
videodraft skills install --agent claude,codex # target specific agents (repeatable/comma; --all for every agent)
videodraft skills install --project            # into ./.claude/skills for just this repo (else global)
npx skills add videodraft-ai/cli               # via the vercel-labs skills tool (discovery / 69-agent multiselect)
```

## Environment variables

| Variable | Purpose |
|---|---|
| `VIDEODRAFT_API_KEY` | Bearer token (`vd_mcp_…`) — skips the login flow |
| `VIDEODRAFT_BASE_URL` | Target server (default `https://app.videodraft.ai`) |
| `VIDEODRAFT_CONFIG_DIR` | Config location (default `~/.config/videodraft`) |
| `VIDEODRAFT_TELEMETRY=0` | Disable telemetry |
| `DO_NOT_TRACK=1` | Disable telemetry (and the update check) |
| `VIDEODRAFT_NO_UPDATE_CHECK=1` | Disable the update notice |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | Proxy support |

## Telemetry

The CLI sends anonymous usage events (command name, CLI version, OS, duration, success/error class — **never prompts, file contents, or arguments**) to help us improve it. Opt out any time:

```bash
videodraft config set telemetry false   # or VIDEODRAFT_TELEMETRY=0 / DO_NOT_TRACK=1
```

## Embedding (`videodraft/client`)

The CLI's core is exported for programmatic use (Node ≥ 20 and Bun):

```ts
import { VideoDraftClient, resolveAuth } from "videodraft/client";

const { tokenProvider, baseUrl } = resolveAuth({}); // flag/env/config-store resolution
const client = new VideoDraftClient({ tokenProvider, baseUrl });
const me = await client.callTool("whoami");
```

## License

MIT © VideoDraft
