set dotenv-load := true
set shell := ["/bin/zsh", "-ic"]
set windows-shell := ["C:/Program Files/Git/bin/bash.exe", "-c"]  # local: no zsh on Windows

project_root := justfile_directory()
app := project_root + "/apps/ten-levels"

# Live through OpenRouter when OPENROUTER_API_KEY is set (put it in .env).
# JEV_BACKEND=mock forces the offline deterministic mock for any recipe.

default:
    @just --list

# Build the Vue app, then serve the lab on port 4399. Kills any listener already on the port, opens the browser.
web:
    cd "{{app}}/web" && bun run build
    lsof -tiTCP:4399 -sTCP:LISTEN | xargs -r kill
    (sleep 1 && open http://127.0.0.1:4399) &!
    cd "{{app}}" && npm run -s web

# Vite dev server with hot reload, proxied to a running `just web`.
dev:
    cd "{{app}}/web" && bun run dev

# Lint the Vue app with oxlint.
lint:
    cd "{{app}}/web" && bun run lint

# Level 1: single decisions, the smart if-statement.
jev1 option="":
    cd "{{app}}" && node src/level.ts 1 {{option}}

# Level 2: fan-out, every question in one call.
jev2 option="":
    cd "{{app}}" && node src/level.ts 2 {{option}}

# Level 3: composite scoring, weights in code.
jev3 option="":
    cd "{{app}}" && node src/level.ts 3 {{option}}

# Level 4: confidence gating, floor and bar.
jev4 option="":
    cd "{{app}}" && node src/level.ts 4 {{option}}

# Level 5: intent and model routing.
jev5 option="":
    cd "{{app}}" && node src/level.ts 5 {{option}}

# Level 6: guardrail hooks, the agent never sees the check.
jev6 option="":
    cd "{{app}}" && node src/level.ts 6 {{option}}

# Level 7: should I compact, four questions after every turn.
jev7 option="":
    cd "{{app}}" && node src/level.ts 7 {{option}}

# Level 8: cheap reads, a judgment about a file without reading it.
jev8 option="":
    cd "{{app}}" && node src/level.ts 8 {{option}}

# Level 9: files at scale, one call per file in parallel.
jev9 option="":
    cd "{{app}}" && node src/level.ts 9 {{option}}

# Level 10: ask_jev on any content, unprompted.
jev10 option="":
    cd "{{app}}" && node src/level.ts 10 {{option}}

# Every level, every option, mock backend.
demo:
    cd "{{app}}" && npm run -s demo

# Every level, every option, live Jev.
demo-live:
    cd "{{app}}" && npm run -s demo:live

# 201 offline tests on the mock.
test:
    cd "{{app}}" && npm run -s test

# 10 live tests against real Jev, one per level.
# Levels 6 to 10 on Claude Code: a fresh sandbox copy with the Jev hooks and the jev MCP tools. Extra args go to claude.
claude *args:
    cd "{{app}}" && node claude/launch.ts {{args}}

test-live:
    cd "{{app}}" && npm run -s test:live

# Re-render the ten hero SVGs.
heroes:
    cd "{{app}}/web" && bun run heroes

# Walk through setup with the /install command in Claude Code.
install:
    #!/usr/bin/env bash
    set -e
    printf '\n\033[1;36m▶ claude --dangerously-skip-permissions "/install"\033[0m\n\n'
    claude --dangerously-skip-permissions "/install"

