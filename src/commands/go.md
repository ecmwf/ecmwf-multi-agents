Carry out an approved plan.

Plan (may be empty): $ARGUMENTS

This may be a new session. Rely on the plan file, not on memory of earlier conversations.

1. Find the plan. Use a path as given; a slug means `.ecmwf-multi-agents/plans/<slug>.md` at the top of the repository. Without either, list the plans newest first with their status, in the shell at the top of the repository: `ls -t .ecmwf-multi-agents/plans/*.md | xargs grep -m1 -H '^Status:'`. If exactly one is not done, use it. If several are, ask which, recommending the most recently changed. If none is found, say so and ask what to do.
2. If its status is `draft`, review it if the policy calls for that, show a short summary and ask for approval first; on approval, set status `approved` with a log line. If it is `done`, say so and stop.
3. Load the skill `ecmwf-multi-agents-plan` with the skill tool and follow its execution procedure.
