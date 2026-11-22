# mend

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files:
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. It finds the lines an edit names even when the model drifted their whitespace or indentation, at the first of
three matching tiers (exact, trailing whitespace, leading and trailing whitespace), and changes every file or none.
`SPEC.md` is the whole specification.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`--format` is `auto` (the default, detected), `unified`, `search-replace`, `v4a` or `json`. `--check` does
everything but write. `--strict` matches lines exactly (tier 0 only). PATCH is the patch file, or standard input
when absent or `-`. See `SPEC.md` for the exact output, exit codes and failure codes.

## Practice score

100 of 100 practice checks pass (practice score 1000); the house's strict applier scores 750 on the same set.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It implements
  every section of SPEC.md. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a
  fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit
code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared,
so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank
context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final
line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice
set does not.
