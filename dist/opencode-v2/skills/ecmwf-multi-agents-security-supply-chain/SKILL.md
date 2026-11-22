---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-security-supply-chain
description: "Checklist for a security review of GitHub Actions, Python dependencies, containers, secrets and scanner hits, each item with an ID to cite. Load when a security review or /harden names it."
metadata:
  opencode/autoinvoke: "false"
---

# Security review of the supply chain and secrets

Cite the ID of the item behind each finding, as `[GA2]`. A scanner hit or a pattern is a candidate until you confirm it in the files.

## GitHub Actions

- GA1 `pull_request_target` or `workflow_run` that checks out the pull request's code and then runs anything from it (`pip install .`, `make`, tests, a local action): that code runs with the repository's secrets. Use `pull_request`, or never run that code there.
- GA2 Free text from an event (an issue or pull request title or body, a comment, `github.head_ref`) inside `${{ }}` in `run:`: it is pasted into the script before the shell runs. Pass it through `env:` and use `"$VAR"`. Numbers and SHAs, such as `github.event.pull_request.number`, are safe.
- GA3 No top-level `permissions:`, or `write-all`: set `contents: read` and widen per job.
- GA4 A third-party action used by tag or branch in a job with secrets, OIDC or publishing: pin a full commit SHA with the tag in a comment, or use a workflow lockfile.
- GA5 `actions/checkout` keeps its token by default; in a job that uploads the workspace as an artifact, set `persist-credentials: false`.
- GA6 A cache restored in a release or publishing job (`actions/cache`, or `setup-python` with `cache:`): a poisoned cache reaches the release. No cache there.
- GA7 Self-hosted runners, such as HPC runners, used by workflows that forks can start: use GitHub-hosted runners for forks.
- GA8 Publishing with a long-lived token (`twine upload` with a PyPI token, `npm publish` with an npm token): use trusted publishing (OIDC) and an `environment:` with required reviewers.

## Python dependencies

- DEP1 `--extra-index-url` or `PIP_EXTRA_INDEX_URL` while internal package names exist: a public package with the same name can win (dependency confusion). Use one index, or an index per package.
- DEP2 An application, a service or CI with no lockfile, or only lower bounds (`>=`): use a lockfile with hashes (`uv lock`, `pip-compile --generate-hashes`) and `--require-hashes`. A library may keep ranges.
- DEP3 `.pth` files with `import` lines, or `sitecustomize.py`, in the project or its environment: they run at every start of Python. Find them with `find`; never start Python to look.
- DEP4 Installing from a URL, a branch or `git+` without a commit hash: pin the hash.
- DEP5 A vulnerable version reported by `pip-audit` or `osv-scanner`: confirm the vulnerable code is used, and say whether it is a runtime or a development dependency.

## Containers

- CT1 `FROM` without a digest, or with `:latest`: pin `image@sha256:...`.
- CT2 No `USER` line, so the container runs as root: add a non-root user.
- CT3 Secrets in `ARG` or `ENV`, or copied into a layer: use BuildKit `--mount=type=secret`.
- CT4 `COPY . .` without a `.dockerignore` that leaves out `.git`, `.env` and keys.
- CT5 `ADD <url>`, `curl | sh` in `RUN`, or downloads in an Apptainer `%post` without a checksum.

## Secrets

- SEC1 Never print a secret. Give the file, the line, its kind and at most its first four characters. List files with `grep -l`, count matches with `grep -c`.
- SEC2 Search the history too: `gitleaks detect --redact`, or `git log -p` piped to `grep -c`.
- SEC3 For a real secret in code or history, advise removing it, rotating it first and rewriting history second. Both are the owner's steps, never yours.
- SEC4 Never use a found secret, not even to check that it works.

## Scanners

- SC1 A scanner hit is a candidate until you confirm it in the code.
- SC2 Never edit scanner config or ignore files, and never add `# nosec`, to make a hit go away.
- SC3 pip-audit, osv-scanner and semgrep registry rules use the network: say when a scan could not run.

## Not findings

A `pull_request_target` workflow that only labels or comments and runs none of the pull request's code; event numbers and SHAs in `run:`; a library's version ranges. Say why you set such a hit aside.
