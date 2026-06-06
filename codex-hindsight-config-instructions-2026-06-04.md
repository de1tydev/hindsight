# Hindsight Codex Configuration Instructions

Date: 2026-06-04

This is the updated executable guide for the Codex agent on another computer. It replaces the earlier guide that used commit `c8ea488fe66a1bbd864c03fbac4fe1a2df553ff7`.

Goal: make Codex on the other machine use the current server's Hindsight memory bank `saber-prod`. The Hindsight API is not exposed directly on `8888`; it is exposed through Nginx on `8890` with Bearer-token barrier authentication.

## 1. Use This Codex Plugin Version

Use the Hindsight Codex integration from the GitHub fork, not only the public installer. The current hooks depend on `scripts/lib/session_summary.py`, so make sure the entire `scripts/` tree is copied.

```text
repo: https://github.com/de1tydev/hindsight.git
branch: main
commit: ac3258b3a6d4f98cb984b404c79fa68f22b73f33
plugin path: hindsight-integrations/codex
plugin settings version: 0.3.0
```

Install or refresh the plugin files:

```bash
git clone https://github.com/de1tydev/hindsight.git
cd hindsight
git checkout ac3258b3a6d4f98cb984b404c79fa68f22b73f33

mkdir -p ~/.hindsight/codex
rsync -a hindsight-integrations/codex/scripts/ ~/.hindsight/codex/scripts/
cp hindsight-integrations/codex/settings.json ~/.hindsight/codex/settings.json
chmod +x ~/.hindsight/codex/scripts/session_start.py
chmod +x ~/.hindsight/codex/scripts/recall.py
chmod +x ~/.hindsight/codex/scripts/retain.py
test -f ~/.hindsight/codex/scripts/lib/session_summary.py
```

Current relevant hook changes since the older `c8ea488f` baseline:

- Codex now supports rolling session summaries through `scripts/lib/session_summary.py`.
- `recall.py` can enrich the recall query with the local session summary, but the summary is not injected directly into the prompt.
- `retain.py` can update the session summary independently of retain cadence.
- Full-session retain still uses `session_id` as `document_id`, so repeated retains upsert the same session document.

## 2. Configure Codex Hooks

Create or update `~/.codex/hooks.json`. If the target machine already has hooks, merge these entries instead of overwriting unrelated hooks.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/.hindsight/codex/scripts/session_start.py\"",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/.hindsight/codex/scripts/recall.py\"",
            "timeout": 12
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/.hindsight/codex/scripts/retain.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Ensure hooks are enabled in `~/.codex/config.toml`:

```toml
[features]
hooks = true
```

If `[features]` already exists, add only `hooks = true`.

## 3. Configure Hindsight Connection

Create or replace `~/.hindsight/codex.json`:

```json
{
  "hindsightApiUrl": "http://192.168.50.55:8890",
  "hindsightApiToken": "<HINDSIGHT_8890_BARRIER_TOKEN>",
  "bankId": "saber-prod",
  "bankMission": "Shared production memory for Master across OpenClaw, Hermes, and Codex. Prioritize durable user preferences, operating rules, project conventions, reusable workflows, lessons, root causes, power/energy domain knowledge, and durable TODE infrastructure facts. Avoid ephemeral task status and runtime history.",
  "retainMission": "Retain only durable facts, preferences, rules, project conventions, reusable workflows, explicit lessons, root causes, power/energy/BPA/TEAP knowledge, durable TODE infrastructure facts, and stable Codex working preferences. Ignore one-off task status, runtime snapshots, test passed notes, commit/PR/issue bookkeeping, process IDs, raw logs, and secrets.",
  "autoRecall": true,
  "autoRetain": true,
  "retainMode": "full-session",
  "retainEveryNTurns": 2,
  "recallBudget": "mid",
  "recallMaxTokens": 1024,
  "recallTimeout": 10,
  "recallTypes": ["observation"],
  "recallContextTurns": 3,
  "recallMaxQueryChars": 4000,
  "recallRoles": ["user", "assistant"],
  "sessionSummaryEnabled": true,
  "sessionSummaryUpdateEveryNTurns": 2,
  "sessionSummaryTimeout": 20,
  "sessionSummaryMaxMessages": 24,
  "sessionSummaryMaxInputChars": 16000,
  "sessionSummaryMaxOutputChars": 2000,
  "sessionSummaryMaxOutputTokens": 700,
  "retainToolCalls": true,
  "retainRoles": ["user", "assistant"],
  "retainTags": ["codex", "prod", "source_system:codex", "{session_id}"],
  "retainMetadata": {
    "source_system": "codex",
    "agent": "codex"
  },
  "retainContext": "codex",
  "dynamicBankId": false,
  "agentName": "codex",
  "debug": false
}
```

Set safe permissions:

```bash
chmod 600 ~/.hindsight/codex.json
```

Key points:

- `hindsightApiUrl` must be `http://192.168.50.55:8890`.
- Do not use `http://192.168.50.55:8890/v1`; the hook appends `/v1/default/...` itself.
- `bankId` must be `saber-prod`.
- `hindsightApiToken` is the Hindsight barrier token for `8890`. It is not the Ask Code `8891` token and not an LLM API key.
- Durable overrides belong in `~/.hindsight/codex.json`; `~/.hindsight/codex/settings.json` is the plugin default template.

Config loading order is:

1. built-in defaults
2. `~/.hindsight/codex/settings.json`
3. `~/.hindsight/codex.json`
4. `HINDSIGHT_*` environment variables

## 4. Parameter Changes From The Previous Guide

The old guide used:

```json
{
  "recallMaxTokens": 3072,
  "recallTypes": ["observation", "world", "experience"]
}
```

The new recommended Codex config uses:

```json
{
  "recallMaxTokens": 1024,
  "recallTypes": ["observation"]
}
```

Reason: Codex auto-recall should be narrow and low-noise. `observation` memories are consolidated durable conclusions and preferences, while `world` and `experience` are raw memory units. Mixing all three in automatic prompt injection can duplicate content and waste context. Use manual Hindsight recall or REST calls when raw `world` or `experience` history is needed for a specific investigation.

Other current parameter choices:

- `recallContextTurns: 3` and `recallMaxQueryChars: 4000` let recall use recent local conversation context.
- `sessionSummaryEnabled: true` lets the hook keep a local rolling summary and use it to enrich recall queries.
- `sessionSummaryUpdateEveryNTurns: 2` updates the summary on the same cadence as retain.
- `retainMode: "full-session"` plus `retainEveryNTurns: 2` means every second turn upserts the full current Codex session under `document_id = session_id`.
- `retainToolCalls: true` preserves structured Codex tool calls and bounded tool outputs in retained session content.

## 5. Verify The Reverse Proxy

First verify unauthenticated access is blocked:

```bash
curl -i http://192.168.50.55:8890/health
```

Expected: `401`.

Then verify with the barrier token:

```bash
curl -fsS \
  -H "Authorization: Bearer <HINDSIGHT_8890_BARRIER_TOKEN>" \
  http://192.168.50.55:8890/health
```

Expected:

```json
{"status":"healthy","database":"connected"}
```

Manual recall smoke test:

```bash
curl -sS -X POST "http://192.168.50.55:8890/v1/default/banks/saber-prod/memories/recall" \
  -H "Authorization: Bearer <HINDSIGHT_8890_BARRIER_TOKEN>" \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "Codex Hindsight configuration smoke test",
    "types": ["observation"],
    "budget": "mid",
    "max_tokens": 800
  }' | python3 -m json.tool | sed -n '1,80p'
```

## 6. Verify Codex Hook State

Start a new Codex session after changing hooks or config. Then inspect:

```bash
ls -lt ~/.hindsight/codex/state | sed -n '1,20p'
```

Useful state files:

- `last_recall.json`: last injected memory block and result count.
- `session_summary_<session_id>.json`: local rolling summary if `sessionSummaryEnabled` is working.
- `bank_missions.json`: banks for which the hook already sent mission config.

If no memory appears, temporarily enable debug mode:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".hindsight" / "codex.json"
data = json.loads(p.read_text())
data["debug"] = True
p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
```

Then start a fresh Codex session and watch hook stderr. Turn `debug` back to `false` after verification.

## 7. Should Skills Be Installed?

Memory integration itself depends on the Codex hooks, not on skills. Installing skills is optional.

Install skills if you also want the other machine's Codex agent to understand Hindsight project structure, documentation, and maintenance conventions:

```bash
mkdir -p ~/.codex/skills
ln -sfn "$PWD/skills/hindsight-docs" ~/.codex/skills/hindsight-docs
ln -sfn "$PWD/skills/hindsight-self-hosted" ~/.codex/skills/hindsight-self-hosted
ln -sfn "$PWD/skills/hindsight-local" ~/.codex/skills/hindsight-local
```

Optional:

```bash
ln -sfn "$PWD/skills/hindsight-cloud" ~/.codex/skills/hindsight-cloud
ln -sfn "$PWD/skills/hindsight-architect" ~/.codex/skills/hindsight-architect
```

Conclusion: install `hindsight-integrations/codex` hooks for memory. Skills are a useful extra for agent understanding and Hindsight maintenance workflows, but they are not required for memory recall or retain.
