# Mod sources

Back to the [`@gamecrate/cli` README](../README.md).

A profile lists mods by package id. This page covers where gamecrate looks for each id, and what
the `library` block and a git pin change. The commands that write the library for you are
`mods add`, `mods rm`, and `mods sync`, listed in the [reference](reference.md). Run
`gamecrate help mods add` for the rules each one follows.

## How a mod is found

The scan visits these places in this order:

| Order | Place | Notes |
| --- | --- | --- |
| 1 | `Data/` in the game install | The core game and the official DLC |
| 2 | Every `scanRoots` entry, in the order you wrote them | Walks down to `maxDepth`, never descends into a mod, skips each `exclude` glob |
| 3 | `<dataRoot>/sources` | The git clone cache |
| 4 | `<dataRoot>/steam`, then `workshopRoot` | One level deep, numeric directories only |

A bare id resolves as an exact package id, then through the game's `aliases` map, then as the last
dot-segment of an id. `workshop:<id>` and `path:<dir>` name a source outright.

When two directories declare the same package id, the first of these rules that applies picks one:

1. A `--use <packageId>=<path>` override.
2. A directory inside the worktree you selected.
3. A non-workshop copy, over a workshop copy.
4. A primary checkout, over a linked git worktree.
5. The earlier scan root.
6. Between two clones of one repository, the one cloned most recently.

A tie on every rule warns with `resolved by directory name: N candidates tie on every rule` and
takes the first directory by name. A tie that involves a selected worktree fails instead. A
directory named `.worktrees` or `.claude/worktrees` is never scanned.

## The library block

A `library` block under a game says where one mod lives. Profiles then name that mod by package id
alone.

```yaml
games:
  rimworld:
    library:
      brrainz.harmony:
        workshop: 2009463077
      yourname.yourmod:
        path: ~/projects/yourmod
      someone.theirmod:
        git: https://github.com/someone/theirmod.git
        tag: v1.4.2
        subdir: Mod
```

| Key | Holds | Rules |
| --- | --- | --- |
| `path` | A directory on this machine | Exactly one of the three per entry |
| `workshop` | A workshop item id | Exactly one of the three per entry |
| `git` | A repository URL | Exactly one of the three per entry |
| `branch`, `tag`, `commit` | The ref to pin to | At most one, and it needs `git` beside it |
| `subdir` | The mod folder inside the repository | Needs `git`. No leading `/`, no `..` segment |

Two source keys is a config error that lists both. None of the three fails the same way.

A pin resolves by its target directory and never consults that ranking. The ranking decides only
unpinned ids and `match:` globs. `--use` beats a pin.

A repo config declares its own `library` at the top level, without the `games` wrapper. A repo pin
replaces a global pin of the same id, and the match ignores case.

## Workshop items

gamecrate fetches workshop items itself, with `steamcmd` and an anonymous login. You need no Steam
account, no running client, and no subscription to an item. See
[Configuration](configuration.md#the-steamcmd-binary) for which `steamcmd` it runs.

A launch fetches every workshop item the profile reaches. It reads each downloaded manifest for
more workshop dependencies and fetches those too, for up to five rounds. It reads the manifest of
every `path:` and `git:` mod as well, so a profile that pins only your own mod still gets the libraries it
declares. A chain unresolved after five rounds fails and lists the ids left over.

A failed download is a warning. The launch keeps going with what is on disk, then reports each
missing item against the profile entry that wanted it. `--dry-run` and `--print-plan` never fetch,
so an item not yet on disk warns and the plan prints marked provisional.

### Where downloads land

```
<dataRoot>/steam/steamapps/workshop/content/<appId>/<id>
```

gamecrate scans that path before `workshopRoot`, so its own copy of an item wins over the Steam
client's. Downloads belong to the game, so every profile of that game shares them.

### `workshopRoot`

`workshopRoot` is the directory the Steam client downloads into. A plugin sets it to `null`,
because where Steam put your library is a fact about your machine:

```yaml
# <steam library>/steamapps/workshop/content/<appId>. RimWorld's appId is 294100
workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
```

`doctor` prints the `steamcmd` it would run and the download root, marking either one missing.

## Git sources

gamecrate clones a git entry into a cache under the data root, one directory per repository and
ref:

```
~/.local/share/gamecrate/sources/<repo>-<hash>/<kind>-<ref>-<hash>/
```

`<repo>` is the last path segment, lowercased. `<kind>` is `branch`, `tag`, or `commit`. The hash
comes from the URL with a trailing `/` or `.git` dropped and the scheme and host lowercased, so
`https://github.com/a/b` and `https://github.com/a/b.git` share one clone. An SSH URL and an HTTPS
URL for one repository do not.

**That cache belongs to gamecrate.** A fetch runs `git reset --hard` in it and throws away your
changes, with no prompt, and no copy. To work on a mod, clone it yourself, and pin that checkout
with `path:`. Nothing evicts the cache, so moving a pin from `v1` to `v2` leaves both clones on
disk.

### Moving pins and fixed pins

- No `branch`, `tag`, or `commit`: every launch asks the remote for its default branch, then fetches
  and resets the clone onto it. An upstream push moves it.
- `branch`: every launch fetches and resets, without asking which branch. An upstream push moves it.
- `tag` or `commit`: nothing. The clone happens once and sits still, and `gamecrate mods sync` alone
  moves it.

### Building a clone

Some repositories commit their assemblies and some keep them out of git. Under the default
`build: auto`, gamecrate compares the two and builds only what it has to:

- Assemblies, none older than the sources: nothing.
- Assemblies older than a source by over a second: runs `dotnet build`.
- Sources and no assembly: runs `dotnet build`.
- No C#: nothing, and never reports stale.

It builds a `.csproj` or `.slnx` in the mod directory itself. A project under `Source/` is never
built, and the stale warning still fires for it.

**So a clone that needs compiling needs a `dotnet` SDK on the host.** A failed build stops the
launch and exits `5`. With no compiler, set `build: never` on the profile or pass `--no-build` for
one run, and the mod loads whatever assemblies the repository shipped.

## Game-level lists

A plugin, or your `games.<game>` block, sets four lists that all load ahead of a profile's own
`mods`:

| List | Holds | Loads |
| --- | --- | --- |
| `preCore` | Anything that must come before the base game | First |
| `core` | The base game | Second |
| `dlc` | The official expansions | Third |
| `base` | What every profile of this game needs | After the DLC |

`--use <packageId>=<path>` is the only override that reaches a mod in one of them. See
[Running](running.md) for worktrees and the mod loop.
