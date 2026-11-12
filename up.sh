#!/usr/bin/env bash
# Bring agentsbuzz up in Docker with one command.
#
#   bash up.sh                  build, start, wait until healthy, print URL and token.
#                               It also finds your projects and follows your agents by itself.
#   bash up.sh --seed           also load sample projects (needs Node on this machine)
#   bash up.sh --tailscale      also share it privately to your phone with tailscale serve
#   bash up.sh --agent-config   also write ~/.agentsbuzz.json so hooks, MCP and the CLI find it
#   bash up.sh --logs           follow the server logs
#   bash up.sh --down           stop it (your data stays in the Docker volume)
#
# Works with the macOS default bash (3.2).
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-7777}"
export PORT
URL="http://127.0.0.1:${PORT}"

SEED=0
TAILSCALE=0
AGENT_CONFIG=0
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --tailscale) TAILSCALE=1 ;;
    --agent-config) AGENT_CONFIG=1 ;;
    --logs) AGENTSBUZZ_TOKEN="${AGENTSBUZZ_TOKEN:-unused}" exec docker compose logs -f --tail=100 buzz ;;
    --down) AGENTSBUZZ_TOKEN="${AGENTSBUZZ_TOKEN:-unused}" docker compose down; echo "Stopped. Data is kept. Run 'bash up.sh' to start again."; exit 0 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# ---- prerequisites ----
command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker Desktop, OrbStack or Colima, then run this again."
docker compose version >/dev/null 2>&1 || fail "The 'docker compose' plugin is missing. Update Docker Desktop, or install the compose plugin."
docker info >/dev/null 2>&1 || fail "Docker is installed but not running. Start Docker Desktop (or OrbStack/Colima) and run this again."

# ---- token: reuse the one in .env, else make one ----
make_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(16))'
  else
    fail "Need openssl or python3 to generate a token. Or set AGENTSBUZZ_TOKEN yourself and run again."
  fi
}

if [ -z "${AGENTSBUZZ_TOKEN:-}" ] && [ -f .env ]; then
  AGENTSBUZZ_TOKEN="$(sed -n 's/^AGENTSBUZZ_TOKEN=//p' .env | head -n 1)"
fi
if [ -z "${AGENTSBUZZ_TOKEN:-}" ]; then
  AGENTSBUZZ_TOKEN="$(make_token)"
fi
export AGENTSBUZZ_TOKEN

# Keep the token in .env (compose reads it, git ignores it) so restarts reuse it.
if ! grep -q '^AGENTSBUZZ_TOKEN=' .env 2>/dev/null; then
  umask 077
  printf 'AGENTSBUZZ_TOKEN=%s\n' "$AGENTSBUZZ_TOKEN" >> .env
  say "Saved a new token to .env"
fi

# ---- what to watch: projects, Claude Code sessions, Codex sessions ----
env_get() { [ -f .env ] && sed -n "s/^$1=//p" .env | head -n 1 || true; }
env_set() { # persist so a plain `docker compose up` behaves the same later
  if ! grep -q "^$1=" .env 2>/dev/null; then umask 077; printf '%s=%s\n' "$1" "$2" >> .env; fi
}

BUZZ_PROJECTS="${BUZZ_PROJECTS:-$(env_get BUZZ_PROJECTS)}"
BUZZ_PROJECTS="${BUZZ_PROJECTS:-$HOME/projects}"
BUZZ_PROJECTS="${BUZZ_PROJECTS/#\~/$HOME}"
[ -d "$BUZZ_PROJECTS" ] || fail "Projects folder not found: $BUZZ_PROJECTS. Run again with BUZZ_PROJECTS=/path/to/your/projects bash up.sh"

BUZZ_CLAUDE="${BUZZ_CLAUDE:-$(env_get BUZZ_CLAUDE)}"
if [ -z "$BUZZ_CLAUDE" ] && [ -d "$HOME/.claude" ]; then BUZZ_CLAUDE="$HOME/.claude"; fi
BUZZ_CODEX="${BUZZ_CODEX:-$(env_get BUZZ_CODEX)}"
if [ -z "$BUZZ_CODEX" ] && [ -d "$HOME/.codex" ]; then BUZZ_CODEX="$HOME/.codex"; fi

mkdir -p .empty
export BUZZ_PROJECTS
[ -n "$BUZZ_CLAUDE" ] && export BUZZ_CLAUDE
[ -n "$BUZZ_CODEX" ] && export BUZZ_CODEX
env_set BUZZ_PROJECTS "$BUZZ_PROJECTS"
[ -n "$BUZZ_CLAUDE" ] && env_set BUZZ_CLAUDE "$BUZZ_CLAUDE"
[ -n "$BUZZ_CODEX" ] && env_set BUZZ_CODEX "$BUZZ_CODEX"

# ---- build and start ----
say "Building and starting agentsbuzz..."
docker compose up -d --build

# ---- wait for healthy ----
say "Waiting for it to become healthy..."
status="starting"
i=0
while [ "$i" -lt 60 ]; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' agentsbuzz 2>/dev/null || echo missing)"
  [ "$status" = "healthy" ] && break
  if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then break; fi
  i=$((i + 1))
  sleep 1
done

if [ "$status" != "healthy" ]; then
  echo "agentsbuzz did not become healthy (status: $status). Last logs:" >&2
  docker compose logs --tail=40 buzz >&2 || true
  exit 1
fi

if [ "$(docker inspect -f '{{.State.Status}}' agentsbuzz-collector 2>/dev/null || echo missing)" != "running" ]; then
  echo "The collector is not running. Last logs:" >&2
  docker compose logs --tail=30 collector >&2 || true
  exit 1
fi

# ---- optional extras ----
if [ "$SEED" -eq 1 ]; then
  if command -v node >/dev/null 2>&1; then
    say "Loading sample projects..."
    AGENTSBUZZ_URL="$URL" node cli/seed.js
  else
    say "Skipping --seed: Node is not installed on this machine."
  fi
fi

if [ "$AGENT_CONFIG" -eq 1 ]; then
  cfg="$HOME/.agentsbuzz.json"
  if [ -e "$cfg" ]; then
    say "Left $cfg alone because it already exists."
  else
    umask 077
    printf '{ "url": "%s", "token": "%s" }\n' "$URL" "$AGENTSBUZZ_TOKEN" > "$cfg"
    say "Wrote $cfg so hooks, the MCP tool and the CLI can find the server."
  fi
fi

PHONE_URL=""
if [ "$TAILSCALE" -eq 1 ]; then
  if command -v tailscale >/dev/null 2>&1; then
    tailscale serve --bg "$PORT" || say "tailscale serve failed. Is Tailscale running and signed in?"
    PHONE_URL="$(tailscale serve status 2>/dev/null | grep -Eo 'https://[^ ]+' | head -n 1 || true)"
  else
    say "Skipping --tailscale: the tailscale command was not found."
  fi
fi

# ---- summary ----
say ""
say "agentsbuzz is running."
say "  On this machine: $URL"
if [ -n "$PHONE_URL" ]; then
  say "  On your phone:   $PHONE_URL"
else
  say "  On your phone:   run 'bash up.sh --tailscale', or 'tailscale serve --bg $PORT'"
fi
say "  Token:           $AGENTSBUZZ_TOKEN   (also saved in .env)"
say ""
say "Watching:"
say "  Projects:            $BUZZ_PROJECTS (new git repos here appear on their own)"
say "  Git commits:         all of them"
if [ -n "$BUZZ_CLAUDE" ]; then say "  Claude Code:         $BUZZ_CLAUDE"; else say "  Claude Code:         not found (no ~/.claude)"; fi
if [ -n "$BUZZ_CODEX" ]; then say "  Codex:               $BUZZ_CODEX"; else say "  Codex:               not found (no ~/.codex)"; fi
say ""
say "Stop it:  bash up.sh --down      Logs:  bash up.sh --logs      Collector logs:  docker compose logs -f collector"
