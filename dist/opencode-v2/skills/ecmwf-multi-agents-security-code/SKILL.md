---
# managed by ecmwf-multi-agents
name: ecmwf-multi-agents-security-code
description: "Checklist for a security review of Python, C, C++, Fortran and shell code: how to rate a finding, and the weaknesses to look for, each with an ID to cite. Load when a security review or /harden names it."
metadata:
  opencode/autoinvoke: "false"
---

# Security review of code

Cite the ID of the item behind each finding, as `[PY5]`. A pattern you find is a candidate: confirm in the code that outside input reaches it before you report it.

## Rating

- R1 A finding names who attacks, the input they control, the boundary crossed and what happens. Without all four it is a hardening note, with no severity.
- R2 Severity never above the impact you can show. Confidence at most medium when you only read the code and did not run it.
- R3 "It is internal", "the tests pass" or "the framework handles it" rule nothing out unless you name the control and where it is.
- R4 Outside input includes command-line arguments, environment variables, files and archives from users or other sites, namelists and config files users edit, downloaded data, and network messages.

## Python

- PY1 `subprocess` with `shell=True`, `os.system` or `os.popen` built from strings: pass a list of arguments, no shell.
- PY2 `pickle.load`, `joblib.load`, `pandas.read_pickle`, `torch.load` without `weights_only=True`, or `numpy.load(allow_pickle=True)` on files from outside: these run code from the file. Use a data format (NetCDF, Zarr, JSON, plain `.npy`) or `weights_only=True`.
- PY3 `yaml.load`, `yaml.full_load` or `yaml.unsafe_load`: use `yaml.safe_load`.
- PY4 `eval` or `exec` on config, namelist values or arguments: use `ast.literal_eval` or a real parser.
- PY5 `tarfile.extractall` without `filter="data"`, or zip members whose names hold `..` or start with `/`: files land outside the target. Use `filter="data"`, and check each member's resolved path.
- PY6 A path from input joined to a base folder: check `resolve()` and `is_relative_to(base)`.
- PY7 `tempfile.mktemp`, or fixed names in `/tmp` or shared scratch: another user can win the race. Use `mkstemp` or `TemporaryDirectory`.
- PY8 `verify=False`, `ssl.CERT_NONE`, `random` for tokens or passwords, or `==` to compare secrets: verify certificates, use `secrets` and `hmac.compare_digest`.
- PY9 SQL built with f-strings or `%`: use query parameters. XML from outside parsed with the standard library or `lxml` defaults: use `defusedxml`.
- PY10 Files or folders made world-writable on shared systems (`0o777`, `umask(0)`): use owner-only modes.

## C and C++

- C1 `gets`, `strcpy`, `strcat`, `sprintf` or `scanf("%s")` into fixed buffers: use bounded calls and check lengths.
- C2 `strncpy` without adding the terminator; `p += snprintf(...)` in a loop without checking the return value against the space left.
- C3 Sizes from input in `malloc(n * size)` or `len - header`: check for overflow and for lengths that are negative or too large; `calloc` checks the product.
- C4 A format string that is not a literal, such as `printf(buf)`: use `printf("%s", buf)`.
- C5 `system()` or `popen()` with input: use `execve` with an argument list.
- C6 `memset` on a key or password just before `free`: the compiler may remove it. Use `explicit_bzero`.
- C7 Missing hardening flags (`-D_FORTIFY_SOURCE=3`, `-fstack-protector-strong`, `-Werror=format-security`) are a hardening note, never a finding on their own.

## Fortran

- F1 Fixed-length `CHARACTER` buffers filled from input, or `READ` without `IOSTAT`: check lengths and `IOSTAT`.
- F2 `EXECUTE_COMMAND_LINE` or `SYSTEM` with strings joined from input: fixed commands with checked arguments.
- F3 Array bounds taken from input (namelists, file headers): check them. Building CI with `-fcheck=bounds` (gfortran) or `-check bounds` (Intel) is a hardening note.

## Shell

- SH1 Unquoted `$var` in commands and paths: quote it as `"$var"`. `eval` on input: remove it.
- SH2 `curl ... | sh` or `bash <(curl ...)`: download, check a checksum from another source, then run.
- SH3 Fixed names in `/tmp`: use `mktemp`. `set -x` near secrets prints them.
- SH4 A missing `set -eu` is a hardening note.

## Not findings

Fixed argument lists such as `subprocess.run(["tar", "czf", out, src])`, `yaml.safe_load`, and code that only tests run, unless it ships to users. Say why you set such a hit aside.
