# reposcore-ts

A CLI for scoring student participation in an open-source class repo, implemented in TypeScript using GraphQL.

## Usage

Install dependencies:

```bash
bun install
```

If you do not pass a token with `--token`, set the `GITHUB_TOKEN` environment variable before running the CLI.

## Synopsis

```text
For more info, run any command with the `--help` flag:
  $ reposcore-ts --help

Usage:
  $ reposcore-ts [...repos]

여러 개의 저장소를 한 번에 분석할 수 있습니다.
  예: reposcore-ts owner/repo1 owner/repo2 owner/repo3

Options:
  --token <token>    GitHub Personal Access Token (default: $GITHUB_TOKEN)
  --format <format>  출력 형식 (csv, txt) (default: csv)
  -h, --help         Display this message
```
