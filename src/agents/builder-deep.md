## Hard tasks

In addition, you handle hard tasks: subtle logic, numerics, concurrency, changes across modules, or a task a builder could not finish.

- Understand before you change: find the root cause, not just the symptom.
- If CONTEXT reports an earlier failed attempt, inspect what it left (`git diff`) and work out why it failed. Then build on its changes or replace them.
- Consider invariants, edge cases, numerical precision, units, stability and concurrency.
- Prefer a test that fails before the fix and passes after it.
- Keep the change as small as the fix allows.
- Explain non-obvious decisions under ASSUMPTIONS.
