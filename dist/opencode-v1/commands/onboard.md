---
# managed by ecmwf-multi-agents
description: "Survey this repository and keep a short summary for later sessions"
agent: lead
---

Survey this repository and keep a short summary for later sessions.

Focus area (may be empty): $ARGUMENTS

1. Read `.ecmwf-multi-agents/context/onboard.md` by exact path, if it exists. It is current when the hash on its `Commit:` line matches `git rev-parse HEAD`, or when it says `none` and there is no commit.
2. Current and no focus area: give the user a short recap from it and stop. Current with a focus area: go to step 4.
3. Otherwise start three scouts in parallel, in one turn:
   - Purpose and intent from README, AGENTS.md, CONTRIBUTING and docs; rules for contributors; docs that look stale.
   - Layout, entry points and main flow; the exact build, test and lint commands.
   - Conventions, recent direction from the changelog, open work and recent commits.
4. With a focus area, send one scout-deep to study it, after any scouts have finished.
5. After the git exclude check in your instructions, write or update `.ecmwf-multi-agents/context/onboard.md`. First line: `Commit: <hash> (<date>)` from `git log -1 --format='%H (%cs)'`, or `Commit: none` outside git or before the first commit. Then these sections, each short, with `path:line` evidence where useful:
   1. Purpose
   2. Architecture
   3. Main data or control flow
   4. Rules that constrain edits
   5. How to build, test and lint
   6. Current direction and open work
   7. Stale or contradictory docs

   Add focus findings to the sections they inform.
6. Apart from the exclude entry, change no other file.
7. Recap the summary for the user in a few lines and offer next steps, such as `/plan` for a piece of work.
