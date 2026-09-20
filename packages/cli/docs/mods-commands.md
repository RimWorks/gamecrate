# The `mods` commands

Back to the [`@gamecrate/cli` README](../README.md).

`gamecrate mods <game> [profile]` prints the resolved mod set: each mod's source kind and
absolute path. Three verbs write the [library](mod-sources.md#the-library-block) for you,
so you never hand-edit a pin or look up a package id.

```sh
gamecrate mods add rimworld --path ~/projects/yourmod --project
gamecrate mods add rimworld --workshop 2009463077 --global
gamecrate mods add rimworld --git https://github.com/someone/theirmod --tag v1.4.2 --global
gamecrate mods rm rimworld yourname.yourmod --project
gamecrate mods sync rimworld
```

## Where a write lands

`add` and `rm` each need `--global` or `--project`, because one write lands in one file. Both,
or neither, is a usage error.

`--global` writes the global config. With nothing on disk yet it creates `profiles.yml`. It
creates that file only once the write is certain, so a refusal never leaves an empty file behind.

`--project` means the nearest `.gamecrate` file, walking up from the current directory. That
file needs a top-level `game:` matching the game you named. Three refusals, each exit `3`:

| Situation | Message |
| --- | --- |
| No `.gamecrate` file in scope | `no .gamecrate config in this directory or any parent; create one with a top-level game:` |
| The file has no `game:` | `<file> has no top-level game:` |
| The file names another game | `<file> belongs to <its game>, not <yours>` |

A write never creates a project file, because creating one means choosing its `game:` for you.

## `mods add`

`add` reads the mod's own manifest for its package id, so you never type an id. It takes
exactly one of `--path`, `--workshop`, or `--git`. Two of them is a usage error, and so is
`--branch`, `--tag`, `--commit`, or `--subdir` next to anything but `--git`.

A `--path` source lands in the config as an absolute path, resolved against the directory you
ran the command from. A `--workshop` source reads `<workshopRoot>/<id>` and writes the number.
With `workshopRoot` still `null` it refuses before touching anything, with exit `3` and the app
id you need to find the directory.

A `--git` source clones the repository first, into the same cache a launch uses, then walks it
for manifests and pins every mod it finds. The walk stops at the first manifest down each
branch of the tree, so per-version `About` folders under one parent manifest stay one entry.
With `--subdir` the walk starts there instead of at the root, and each pin records its own
`subdir` relative to the repository root. Every pin records the ref you typed as
`branch`, `tag`, or `commit`. With none, the pin follows the default branch.

Two separate directories that declare the same package id are a different case. `add` refuses
the whole batch with exit `3` and names both directories, because nothing tells it which one you
meant. Start the walk lower down with `--subdir` to pick one. `--force` does not apply here; it
only overwrites a pin that is already in the target file.

An id already in the target library stops the whole write, listing every clash. The match
ignores case. `--force` overwrites those entries instead, deleting the old key first so a
replacement never merges with what was there.

A source with no readable manifest fails with `no mod manifest at <source>` and exit `4`.

**One `add` is one write.** However many pins a repository yields, gamecrate checks all of them
against the file first and writes once. A collision anywhere leaves the file untouched. The
write goes to a temporary file that is renamed over the target, so a crash leaves the old config
rather than half of one. gamecrate writes a symlinked config through to its target, and the file keeps
its mode.

## `mods rm`

`rm` takes one or more package ids and reports any it cannot find in the target file. A missing
id is exit `3`, not a silent success, because a typo that reports success is worse than one
that reports a miss. `rm` never touches the clone cache.

Emptying a `library` map deletes the map too, and any parent the delete leaves empty. An empty
YAML map re-emits as `{}`, and the next write into it would come out as a one-line flow map.

## `mods sync`

`sync` takes an optional game, then any number of package ids. The first word after `sync` is
always the game name, so `gamecrate mods sync some.mod` reads `some.mod` as a game and fails
with `unknown game some.mod`. With no game, it walks every game. With no ids, it fetches every
git-pinned clone it finds. With nothing to do it prints `nothing to sync` and exits `0`.

An id you name that has no `git` entry stops the whole sync with exit `4`, listing every id it
could not find. It fetches with force, so it moves tag and commit pins that a launch leaves
alone. It creates a clone that does not exist yet. One repository pinned by several ids is
fetched once, and every id you named gets its own `synced <id> at <kind> <ref>` line.

A fetch that fails prints the same warning a launch does and keeps the clone on disk.

## YAML writes and JSON writes

**A YAML write rewrites the whole file.** Comments, values, and quote style all survive, but the
original indentation and blank lines do not. A JSON or JSONC write changes only the bytes it
has to, and matches the indent it finds in the file.

`--help` works on all three verbs, even with the game missing, or the source missing. You can read the
help for a command before you know how to type it.
