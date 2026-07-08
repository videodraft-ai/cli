# Install for Agents

You are an AI coding agent. The user asked you to install the VideoDraft skill. Follow this exactly.

## Step 1 — Install the VideoDraft CLI

Always install the latest release. An older `videodraft` already on PATH lacks this skill and the `videodraft skills show` used in Step 4, so update it rather than skip:

```bash
npm install -g videodraft
```

No Node global? Use `npx -y videodraft@latest <cmd>` for **every** command in this guide (`login`, `whoami`, `skills install`, `generate`): it runs the current CLI without installing, the `-y` skips npx's install prompt so it works non-interactively, and bare `videodraft` won't be on PATH. Verify: `videodraft --version` or `npx -y videodraft@latest --version`.

## Step 2 — Authenticate

Ask the user to run (it opens their browser for a one-click sign-in):

```bash
videodraft login
```

Never ask the user to paste a `vd_mcp_...` token into the chat. In headless/CI, set `VIDEODRAFT_API_KEY` instead. Verify: `videodraft whoami`.

## Step 3 — Install the skill

The CLI installs itself into the right place for each agent (it auto-detects the agents you actually have installed). Use `--force` so it overwrites an older skill from a previous version rather than skipping it:

```bash
videodraft skills install --force
```

This writes the skill to whichever of these exist:

| Agent | Path |
|---|---|
| Claude Code | `~/.claude/skills/videodraft` |
| Codex | `~/.codex/skills/videodraft` |
| Cursor | `~/.cursor/skills/videodraft` |

Target specific agents with `--agent claude,codex`, or force all three with `--all` (which creates the directories even for agents that aren't installed — only use it if that's what you intend).

Cross-agent alternative (any of the 60+ agents the community tool supports):

```bash
npx -y skills add videodraft-ai/cli -g -y
# npx -y skips npx's package-install prompt (must come before the package); -g = user scope; the trailing -y skips the skills tool's own prompt
# gh: name the skill + user scope, else it lists skills or installs only into the current repo
gh skill install videodraft-ai/cli videodraft --scope user
```

## Step 4 — Verify

Confirm the install without spending credits (do **not** run a real generation just to check it, that costs the user credits):

```bash
# auth must succeed first; exit 3 (not authenticated) stops here before the file check:
videodraft whoami || { echo "AUTH FAILED: run 'videodraft login' (Step 2), then retry"; exit 3; }

# Confirm the skill landed in an agent's dir (the INSTALLED copy, not the CLI's bundled one).
# Agents you don't have are ignored; "OK" means the skill exists for at least one you do have.
if [ -f ~/.claude/skills/videodraft/SKILL.md ] || [ -f ~/.codex/skills/videodraft/SKILL.md ] || [ -f ~/.cursor/skills/videodraft/SKILL.md ]; then
  echo "OK: skill installed"
else
  echo "MISSING: re-run Step 3 (videodraft skills install --force)"
  exit 1
fi
```

`videodraft skills show` prints the skill text but reads the CLI's **bundled** copy, so it is not proof that the install landed in the agent's directory.

If you want a generation smoke test, quote the cost first with `videodraft generate image "a red fox in snow" --estimate` (spends nothing), then run the real command only after the user approves the spend.

If anything fails:
- exit 3 (`not authenticated`) → repeat Step 2 (`videodraft login`)
- prints `MISSING` → Step 3 did not install for your agent; re-run `videodraft skills install --force` (or target it with `--agent`)
- otherwise → read the error and report it to the user

## Step 5 — Done

Tell the user: "VideoDraft skill installed. Try: 'Generate me a [thing]' or 'Turn this idea into a video.'" Do not explain the internal file layout.
