# Skills

A skill is another way to use this project, with no MCP server. It's a folder
with instructions (`SKILL.md`) and a small script. An AI agent that can run
commands, like [Claude Code](https://claude.com/claude-code), reads the
instructions when a subway question comes up and runs the script to get the
answer.

## `mta-subway`

The same four tools as the MCP server, as a command-line script:

```bash
node skills/mta-subway/scripts/mta.mjs check_route_on_date '{"route_id":"6","date":"2026-09-26","station":"68 St-Hunter College"}'
node skills/mta-subway/scripts/mta.mjs --help
```

The script runs the server's own code from `dist/`, so both give the same
answers, including the station matching, the alert classification, the
station ADA status and alternate routes, and the disclaimers. The ADA status
and alternate routes come from snapshots in `data/`, so they add no request.
The script adds a 60-second cache on disk so repeat questions reuse one
download. The server's cache lives in memory, and each script run is a new
process.

### MCP or skill?

| | MCP server | Skill |
|---|---|---|
| Works in chat apps like Claude Desktop | Yes | No. The agent must be able to run commands |
| Works in other AI tools that support MCP | Yes | Mostly Claude only |
| Always-on cost per conversation | About 1,000 tokens for the tool descriptions | A one-line description. The full instructions load only when used |
| Size of a typical answer | Compact JSON, often under 2,000 tokens | The same |
| Spacing out requests to MTA | Enforced across every call | Enforced within a run. The disk cache covers repeat questions, but two runs at the same moment could both fetch |

Use the MCP if you work in a chat app or want the strongest rate limiting. Use
the skill if you work in Claude Code and want to skip the roughly 1,000 tokens
the MCP's tool descriptions add to every conversation.

For scale: on 2026-09-22 the raw alerts feed was about 740,000 characters,
roughly 200,000 tokens. Both the MCP and the skill filter it down before the
agent sees anything. Pointing an agent at the raw feed instead would put all
of it in the conversation.

### Install

1. Build this repo, if you haven't:

   ```bash
   git clone https://github.com/BetaNYC/mta-mcp.git ~/Code/mta-mcp
   cd ~/Code/mta-mcp
   npm install
   ```

2. Link the skill into your Claude Code skills folder. Linking keeps it up to
   date when you pull.

   ```bash
   mkdir -p ~/.claude/skills
   ln -s ~/Code/mta-mcp/skills/mta-subway ~/.claude/skills/mta-subway
   ```

   For one project only, link it into that project's `.claude/skills/` instead.

3. Start a new Claude Code session and ask a subway question.

If you put the repo somewhere other than `~/Code/mta-mcp` and copy the skill
folder instead of linking it, set `MTA_MCP_DIR` to the repo's path.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `MTA_MCP_DIR` | the repo the script is in, then `~/Code/mta-mcp` | Where to find the built server code |
| `MTA_MCP_CACHE_TTL_MS` | `60000` | How long a cached feed is reused. Please don't lower it |
| `MTA_SKILL_CACHE_DIR` | a folder in your system's temp directory | Where the disk cache lives |

The same terms apply as for the server. See
[docs/terms-compliance.md](../docs/terms-compliance.md).
