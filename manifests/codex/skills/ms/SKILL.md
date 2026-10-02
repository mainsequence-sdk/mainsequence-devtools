---
name: ms
description: Explicit MainSequence developer commands registered in the Codex slash menu and executed by the local UserPromptSubmit hook.
---

This entry registers `ms` in the Codex slash menu. Select it, then append command arguments such as `--help`, `auth-status`, or `sync`.

The plugin's trusted `UserPromptSubmit` hook executes these commands and ends the turn before inference. If these instructions reach the model, the hook did not intercept the command: report that the plugin hook must be enabled and trusted. Do not execute the action through model tools or MainSequence MCP.
