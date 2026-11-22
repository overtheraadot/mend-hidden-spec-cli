# mend-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/overtheraadot/mend-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/overtheraadot/mend-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a single-file patch tool (Node.js 22, stdlib only) that applies AI-written edits in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits — to a tree of text files, with three-tier line matching, safe paths and atomic application.

## Run it

```sh
node main.ts patch.diff
```

Apply a patch from a file, or pipe it in (`cat patch.diff | node main.ts`). Flags: `--format=unified|search_replace|v4a|json` to force a format, `--check` to dry-run, `--strict` for exact-only matching. See SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
