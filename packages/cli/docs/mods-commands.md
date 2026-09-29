# The `mods` commands

Back to the [`@gamecrate/cli` README](../README.md).

`gamecrate mods [profile]` prints the resolved mod set: each mod's source kind and
absolute path. Three verbs write the [library](mod-sources.md#the-library-block) for you,
so you never hand-edit a pin or look up a package id.

```sh
gamecrate mods dev
gamecrate mods dev --only yourname.yourmod --without someone.theirmod
```

The list takes the same set flags a launch does, so you preview a mod set before you spend a
launch on it:

| Flag | Does |
| --- | --- |
| `--mod <id>` | Add one more mod to what the profile loads |
| `--without <id>` | Leave one mod out |
| `--only <id>` | Load these and none of the rest |
| `--sort <topo\|none>` | Order by dependency, or as the profile lists them |
| `--json` | Print the set as JSON instead of text |

`--mod`, `--without`, and `--only` are repeatable. None of these flags write anything to disk.

```sh
gamecrate mods add --path ~/projects/yourmod --project
gamecrate mods add --workshop 2009463077 --global
gamecrate mods add --git https://github.com/someone/theirmod --tag v1.4.2 --global
gamecrate mods rm yourname.yourmod --project
gamecrate mods sync
```

## Where a write lands

`add` and `rm` each need `--global` or `--project`, because one write lands in one file. Both,
or neither, is a usage error.

`--global` writes the global config. With nothing on disk yet it creates `config.yml`. It
creates that file only once the write is certain, so a refusal never leaves an empty file behind.

`--project` means the nearest `.gamecrate` file, walking up from the current directory. That
file needs a top-level `game:` matching the game the command acts on. Three refusals, each
exit `3`:

| Situation | Message |
| --- | --- |
| No `.gamecrate` file in scope | `no .gamecrate config in this directory or any parent; create one with a top-level game:` |
| The file has no `game:` | `<file> has no top-level game:` |
| The file declares another game | `<file> belongs to <its game>, not <yours>` |

A write never creates a project file, because creating one means choosing its `game:` for you.

## `mods add`

`add` reads the mod's own manifest for its package id, so you never type an id. It takes
exactly one of `--path`, `--workshop`, or `--git`. Two of them is a usage error, and so is
`--branch`, `--tag`, `--commit`, or `--subdir` next to anything but `--git`.

A `--path` source lands in the config as an absolute path, resolved against the directory you
ran the command from.

A `--workshop` source downloads the item, reads the manifest out of that copy, and writes the
number. You do not need `workshopRoot` set for this. **It downloads even when `workshopRoot`
already holds that item.** The Steam client's copy is yours, and a pin has to work on a machine
that never subscribed to the item. A download that fails stops the write with exit `4` and a
link to the item's page. So a private or removed item never lands in your config as a pin.

A `--git` source clones the repository first, into the same cache a launch uses, then walks it
for manifests and pins every mod it finds. The walk stops at the first manifest down each
branch of the tree, so per-version `About` folders under one parent manifest stay one entry.
With `--subdir` the walk starts there instead of at the root, and each pin records its own
`subdir` relative to the repository root. Every pin records the ref you typed as
`branch`, `tag`, or `commit`. With none, the pin follows the default branch.

Two separate directories that declare the same package id are a different case. `add` refuses
the whole batch with exit `3` and lists both directories, because nothing tells it which one you
meant. Start the walk lower down with `--subdir` to pick one. `--force` does not apply here; it
only overwrites a pin that is already in the target file.

An id already in the target library stops the whole write, listing every clash. The match
ignores case. `--force` overwrites those entries instead, deleting the old key first so a
replacement never merges with what was there.

A source with no readable manifest fails with `no mod manifest at <source>` and exit `4`.

**One `add` is one write.** gamecrate checks every pin against the file first, then writes them
all at once. A collision anywhere leaves the file untouched. It writes to a temporary file and
renames that over the target, so a crash leaves you the old config rather than half of one.
gamecrate follows a symlinked config through to its target, and keeps the file's mode.

## `mods rm`

`rm` takes one or more package ids and reports any it cannot find in the target file. A missing
id is exit `3`, not a silent success, because a typo that reports success is worse than one
that reports a miss. `rm` never touches the clone cache.

Removing the last entry in a `library` map deletes the map itself, and any parent the delete
leaves empty.

## `mods sync`

`sync` takes any number of package ids. It acts on one game when any of three say which:
`--game`, the nearest `.gamecrate` file's `game:`, or a config that declares only one game. With
none of the three, `sync` walks every game. With no ids, it fetches every git- or
workshop-pinned mod it finds. With nothing to do it prints `nothing to sync` and exits `0`.

An id you name that has neither a `git` nor a `workshop` entry stops the whole sync with exit
`4`, listing every id it could not find. It fetches with force, so it moves tag and commit pins
that a launch leaves alone. It creates a clone that does not exist yet. One repository pinned by
several ids is fetched once, and every id you named gets its own `synced <id> at <kind> <ref>`
line. A fetch that fails prints the same warning a launch does and keeps the clone on disk.

A workshop pin syncs the same way. `sync` asks Steam which of the items changed, downloads only
those, and prints `synced <id> at workshop item <number>` for each. An item Steam reports as
unchanged prints `<id> is up to date at workshop item <number>` and downloads nothing. An item
Steam refuses to serve, because the author removed or hid it, prints `<id> is unavailable at
workshop item <number>`. All the items for one game go through a single `steamcmd` run, because
connecting costs far more than the transfer does.

## Workshop mods update themselves on a launch

You do not have to run `sync` to get a new version of a workshop mod. Every launch asks Steam
whether the profile's workshop items changed since the copies on disk, and downloads the ones
that did. An item Steam cannot answer for, or one it reports as private or removed, is left
alone with a warning.

So a workshop mod can change version under an existing save between one launch and the next.
To hold a mod still, pin it with `path:` or `git:` instead, and keep that checkout yourself.

## YAML writes and JSON writes

**A YAML write rewrites the whole file.** Comments, values, and quote style all survive, but the
original indentation and blank lines do not. A JSON or JSONC write changes only the bytes it
has to, and matches the indent it finds in the file.

`--help` works on all three verbs, even with the source missing.
