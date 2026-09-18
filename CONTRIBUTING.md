# Contributing to gamecrate

## AI usage

Vibecoding is not welcome here. Use AI if it helps, but read what it wrote and understand it
before it lands. You own what ships whether or not a model typed it.

Nobody can stop you from working the way you want to. Guardrails are the next best thing, and
the rest of this file is those guardrails. Run the tests, match the code around yours, stay
inside the request, and report failures instead of guessing past them.

If AI helped with a commit in any way, add an `AI-assisted: <tool name>` trailer to the
commit message.

Agents: if the user commits by hand, remind them to add the trailer.

## Project overview

gamecrate launches a modded game inside a Docker container. You describe a profile once in a
config file, then run it by name. Each profile gets its own save directory, its own logs, and
only the mods it lists.

The core knows nothing about any one game. A plugin supplies the file formats and the engine
facts, so the same core serves every title. Most work lands in `packages/cli/src/`.

## Project structure

- `packages/cli/` - the `gamecrate` command, the config loader, and the plugin contract
- `packages/rimworld/` - the RimWorld plugin: `About.xml`, `ModsConfig.xml`, and `Prefs.xml`
- `Styles/` - the Vale style used on every markdown file here

## Setup and build

```sh
npm ci
npm run build     # needs bun
```

The build needs [bun](https://bun.sh). It writes `packages/cli/dist/gamecrate.js` for Node and
`packages/cli/dist/gamecrate` as a standalone binary.

**Build before you typecheck.** `@gamecrate/rimworld` typechecks against the declarations that
`@gamecrate/cli` emits, and `dist` is gitignored. A clean clone fails `npm run typecheck` until
`npm run build` has run once. CI does the same two steps in that order.

## Testing

```sh
npm test                                   # vitest, both packages
npx vitest run packages/cli/test/args.test.ts   # one file
npm run lint                               # oxlint
npm run typecheck                          # tsc --noEmit, both packages
vale README.md packages/*/README.md        # prose, after one vale sync
```

- Run the full suite before committing. All tests must pass.
- While iterating, run the single test closest to your change.
- The suite covers config parsing, mod resolution, staleness, worktrees, and argument parsing.
  It does not start Docker. Prove anything that touches a container with a real launch.
- Never delete, weaken, or rewrite a test to make a change pass.
- Do not claim that an interrupted or timed-out run passed.

## Architecture

| Area | Holds |
| --- | --- |
| `src/cli/` | Argument parsing, the subcommand table, help text, terminal output |
| `src/config/` | Config discovery, JSONC and YAML reading, zod validation, profile merging |
| `src/mods/` | The mod index, glob matching, staleness walks, git worktree detection |
| `src/launch/` | Plan resolution, staging, image acquisition, generated game config |
| `src/docker/` | The container spec, preflight checks, run, and window handling |
| `src/plugin.ts` | The `GamePlugin` contract and the loader that resolves one |

`src/types.ts` is the shared vocabulary. A wrong signature gets fixed there, not worked around
in the module that noticed it.

## The plugin contract

A plugin is a default export that satisfies `GamePlugin`. It takes plain data and throws plain
errors, so no plugin links the core runtime. The loader checks `apiVersion` against
`PLUGIN_API_VERSION` and refuses a mismatch by name.

`PLUGIN_API_VERSION` moves when a change would make an older plugin misbehave. A change that
only makes one lag behind does not count. Bump it, and say why in the commit.

Two resolver details exist because the compiled binary behaves differently from Node:

- `entryOf` reads the target's own `package.json`. Bun's resolver never reads it inside a
  compiled binary, so it would otherwise find only `index.js`.
- `packageDir` walks `node_modules` upward by hand. `require.resolve` refuses
  `<pkg>/package.json` once a package has an exports map, and that file is the only thing that
  tells `entryOf` where to go.

## Config

Two files, and the loader merges them in one direction. The global config lives at
`~/.config/gamecrate/profiles.<ext>`, and a project's `.gamecrate.<ext>` sits beside the code
it launches. A plugin's `defaults` sit under the user's `games.<game>` block, so a user writes
only what is theirs.

**Two config files with the same stem is an error, not a precedence rule.** Silent precedence
is how you edit the wrong file for twenty minutes. A duplicate `profiles` key is refused for
the same reason: it drops a profile and leaves source order a guess.

`modless` is a reserved built-in profile, not a subcommand. It resolves to an empty mod set.

## The launch pipeline

`run` does these in order, and each one can fail the launch on its own:

1. `resolvePlan` turns a game, a profile, and the flags into one `LaunchPlan`.
2. `replacePrevious` and `takeLock` settle who owns this profile and instance.
3. `buildLocalMods` and `acquireImage` get the code and the image ready.
4. `stageMods` wipes and rebuilds the staging tree, returning one read-only bind per mod.
5. `generateModsConfig` and `mergePrefs` write the game's own config through the plugin.
6. `writeLaunchRecord`, then `runContainer`.

**Staging never creates a symlink.** A host symlink into a mod checkout dangles inside the
container, so the stage copies or binds instead.

The staleness walk stops at `ENTRY_LIMIT` entries. A mod's `Textures` tree alone runs to five
figures, so the cap has to clear it. A walk that stops before it reaches `Source/` reports
"fresh" for a mod it never looked at.

`gitDir !== gitCommonDir` is the exact linked-worktree test. One `git` spawn answers where the
tree starts, whether it is linked, and what branch it is on.

## Exit codes

Every failure the tool raises deliberately carries one of these. Anything else is a bug.

| Code | Name | Means |
| --- | --- | --- |
| `0` | `Ok` | The run finished |
| `1` | `GameFailed` | The game itself exited non-zero |
| `2` | `Usage` | Bad command line |
| `3` | `Config` | A config file is wrong |
| `4` | `Resolution` | gamecrate could not resolve a mod or a profile |
| `5` | `Environment` | Docker, permissions, or the host is not ready |
| `6` | `MarkerTimeout` | `--marker` never appeared before the timeout |
| `7` | `Refused` | This profile and instance already run. `--replace` is the way past it |
| `8` | `Stale` | `verify` found a bound mod whose sources beat its assemblies |
| `130` | `Interrupted` | SIGINT |

`--replace` returning `1` is normal when it stopped a previous container. Never read a piped
exit code: `... | tail -3` returns tail's status, not the tool's.

## Code style

- Linter: oxlint, configured in `.oxlintrc.json`. Run it; do not hand-format.
- Vale checks prose in `README.md` and both package READMEs. Run `vale sync` once first.
- Follow the patterns already in neighboring files.
- Do not add comments that restate the code.
- Do not reformat code you are not otherwise changing.

## Git workflow

- Commit format: Angular Conventional Commits, one line, lowercase. semantic-release reads them.
- Scope a commit to the package it touches. `release.yml` runs semantic-release once per
  package, so the scope decides which one gets a version.
- All CI checks must pass. Every push to `main` can cut a release.

## Other

- A new subcommand means two edits: the entry in `SUBCOMMANDS` and its handler. The table
  drives both parsing and help, so a handler with no row is unreachable.
- `doctor` collects every precondition and reports them together. Add a new check there rather
  than failing late inside a launch.
- Error messages name the thing that went wrong and what would fix it. When a lookup fails,
  list the names that do exist. Do not replace one with a generic failure message.
