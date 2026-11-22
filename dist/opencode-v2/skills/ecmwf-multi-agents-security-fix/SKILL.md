---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-security-fix
description: "Rules and recipes for fixing a security finding safely, and the verdicts for rechecking a fix. Load when /harden names it."
metadata:
  opencode/autoinvoke: "false"
---

# Fixing a security finding

For the builder fixing a finding the user picked, and for the inspector's recheck. The brief comes first; these rules come with it.

## Rules

- FX1 Fix the root cause: where the input enters, or the shared function, not one caller.
- FX2 Prefer an allow-list, a parameterised API or a type to a check for known bad input.
- FX3 Fail closed: no `try/except: pass` around a check, and no setting that turns the check off by default.
- FX4 Never swap a dangerous call for a sibling: `os.system` to `subprocess.run(..., shell=True)` is not a fix.
- FX5 Add a regression test with the attacking input that fails before your change and passes after it. Say in your report that you saw it fail.
- FX6 Search for the same pattern elsewhere (`git grep`). Report each place you find; fix only what the brief names.
- FX7 Never add `# nosec` or `# noqa`, and never change scanner config or ignore files.
- FX8 Dependencies: the smallest version that removes the weakness, never a downgrade. Update the lockfile and run the tests.
- FX9 Workflows: pin an action to a full commit SHA with the tag in a comment, and set `permissions` per job.
- FX10 Secrets: remove the value and read it from the environment or a secret store. Report that the owner must rotate it. Never rewrite history.

## Recipes

- RC1 Commands: `subprocess.run(["tar", "czf", out, src], check=True)`. Put `--` before names that come from input, or refuse names that start with `-`.
- RC2 Files from outside: `yaml.safe_load`; `tarfile.extractall(dest, filter="data")`; `torch.load(path, weights_only=True)`; JSON or NetCDF instead of pickle.
- RC3 Paths: `target = (base / name).resolve()`, and refuse unless `target.is_relative_to(base.resolve())`.
- RC4 Temporary files: `tempfile.mkstemp()` or `tempfile.TemporaryDirectory()`.
- RC5 Tokens and secrets: `secrets.token_urlsafe()`, and `hmac.compare_digest(a, b)` to compare them.
- RC6 C: check `snprintf`'s return value against the space left; check sizes for overflow; `explicit_bzero` before `free`.
- RC7 Shell scripts: quote `"$var"`; use `mktemp`; remove `eval`.

## Recheck verdicts

- RV1 CLOSED: the input can no longer reach the weak call on any path, and the regression test shows it.
- RV2 PARTLY: the fix guards one path of several, filters only the known bad input, fails open, sits behind an option that is off by default, or moved the problem to a sibling call.
- RV3 OPEN: the original input still reaches the weak call.
