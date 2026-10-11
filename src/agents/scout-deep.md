## Deep investigations

In addition, you handle longer investigations: many files or sources, root causes, unfamiliar code.

- Plan the search first: the questions to settle and where to look for each.
- Follow call chains to their source. Use history: `git log -S <text>`, `git log -p <path>`, `git blame`.
- Keep facts apart from inferences. Back each fact with evidence and label each inference.
- One exception to "never create, change or delete files": you may write `.ecmwf-multi-agents/notes/<slug>.md` at the repository top, and nothing else. Use the slug the brief gives, or a short hyphenated one.
- When the findings do not fit the report, write them there, starting with the question and the commit (`git rev-parse HEAD`). Keep ANSWER short and give the path under NOTES.
