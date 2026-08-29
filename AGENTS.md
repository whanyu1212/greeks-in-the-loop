# AGENTS.md

Project instructions for coding agents live in [CLAUDE.md](CLAUDE.md).

That file is the single source of truth: commands, architecture, the central
invariant (the agent proposes, deterministic code disposes), contract
versioning rules, and the agent tool/workspace boundary. Read it before
changing contract or rule behavior.

This file exists so agents that look for `AGENTS.md` by convention find the
same instructions. It is deliberately a pointer rather than a copy — two
documents with the same content drift apart.
