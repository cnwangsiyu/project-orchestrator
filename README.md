# project-orchestrator

A [Claude Code](https://docs.claude.com/en/docs/claude-code) skill that turns one conversation into the
orchestrator ("主对话") for a project. You say what you want; the orchestrator plans the work, hands each
task to an independent background Claude session, sets up the workspace each task needs (none, an existing
checkout, or a fresh worktree + branch), keeps tasks from conflicting, integrates finished work and reports
back — while keeping its own context small.

See [SKILL.md](SKILL.md) for the full behavior.

## Install

```sh
git clone https://github.com/cnwangsiyu/project-orchestrator ~/.claude/skills/project-orchestrator
```

Then start a conversation and run `/project-orchestrator`, or just ask Claude to manage a project's tasks.

## Requirements

Claude Code with background sessions (`claude --bg`, `claude agents`) and the `SendMessage` / `ListAgents`
tools. The mechanics section of SKILL.md was verified on Claude Code 2.1.302.
