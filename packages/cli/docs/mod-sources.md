# Mod sources

Back to the [`@gamecrate/cli` README](../README.md).

A profile names mods by package id. This page explains where gamecrate looks for each id. It
also covers how the `library` block pins one id to one place, and what a git-backed pin does on
every launch.
The commands that write the library for you are on [their own page](mods-commands.md).

## How a mod is found

gamecrate builds an index of every mod it can see, then resolves each profile entry against it.
The scan visits, in this order:

1. The `Data/` directory inside the game install, which holds the core game and the official DLC.
2. Every `scanRoots` entry, in the order you wrote them. A root walks down to its `maxDepth`,
   never descends into a mod once it finds one, and skips any `exclude` glob you gave it.
3. The git clone cache under `<dataRoot>/sources`, described below.
4. The workshop download root under `<dataRoot>/steam`, then `workshopRoot`. Each one goes one
   level deep, numeric directories only.

A bare id resolves as an exact package id first, then through the game's `aliases` map, then as
the last dot-segment of an id. A short name that fits more than one mod fails with `"<name>" is
a short name for N mods`. `workshop:<id>` and `path:<dir>` skip the ladder and name a source
outright.

When two directories declare the same package id, one wins:

1. A `--use <packageId>=<path>` override.
2. A directory inside a worktree you selected with `--worktree`, `$GAMECRATE_WORKTREE`, or by
   standing in it.
3. A non-workshop copy over a workshop copy.
4. A primary checkout over a linked git worktree the scan wandered into.
5. The earlier scan root. The game install beats every root you configured, and every root you
   configured beats the clone cache.
6. Between two clones of one repository in the cache, the one cloned most recently.

Two candidates that tie on every rule fail the command with `resolved by directory name: N
candidates tie on every rule`.

A directory named `.worktrees` or `.claude/worktrees` is never scanned. A worktree only counts
when you select it.

## The library block

A `library` block under a game says where one mod lives. Profiles then name that mod by its
package id alone, and the library supplies the rest.

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

Each entry carries exactly one of `path`, `workshop`, or `git`. Two of them is a config error
that names both keys. An entry with none of the three fails the same way.

`branch`, `tag`, and `commit` pin a git entry to one ref. An entry takes at most one of the
three. `subdir` names the mod folder inside the repository, for a repo that holds the mod
somewhere below its root. All four keys need a `git` URL beside them, so a `path` or `workshop`
entry that carries one fails with `"tag" needs a "git" url`. A `subdir` starting with `/`, or
holding a `..` segment, fails as well.

A pin resolves by its target directory and never consults the precedence ladder. So a pinned id
always loads from its pin, even when a scan root holds another copy. The ladder decides only for
unpinned ids and `match:` globs. `--use` is the one thing that beats a pin.

A repo config declares its own `library` at the top level, without the `games` wrapper. A repo
pin replaces a global pin of the same id outright, and the match ignores case.

## Workshop items

gamecrate fetches workshop items itself. It runs `steamcmd` with an anonymous login, so you
need no Steam account, no Steam client running, and no subscription to the item. See
[Configuration](configuration.md#the-steamcmd-binary) for which `steamcmd` it runs.

A launch fetches every workshop item the profile reaches, then reads each downloaded manifest
for workshop dependencies and fetches those too. That repeats for up to five rounds, so a
dependency of a dependency still arrives. A chain still unresolved after five rounds is a
launch problem that names the ids left over. Name them in the profile to get them in the first
round.

Mods you pin yourself count as well. A launch reads the manifest of every `path:` and `git:`
mod the profile reaches, and fetches the workshop items they depend on. So a profile that
pins only your own mod still gets the libraries it declares.

A download that fails is a warning, not a failure. The launch keeps going with whatever is
already on disk. It then reports each item still missing against the profile entry that wanted
it.

`--dry-run` and `--print-plan` never fetch. An item that is not on disk yet reads as `workshop
item <id> is not fetched, and fetching is off for this command; a real launch would fetch it`.
That is a warning, not a failure. The plan still prints, with a note that it is provisional.

### Where downloads land

Every item lands in one place:

```
<dataRoot>/steam/steamapps/workshop/content/<appId>/<id>
```

gamecrate pins that with `+force_install_dir`, so the path does not change with the `steamcmd`
you point it at. Left alone, each build picks its own: a host binary writes `.steam/SteamApps`,
the `steamcmd/steamcmd` image writes `.local/share/Steam/steamapps`, and a Valve tarball writes
`$HOME/Steam`.

gamecrate scans that root, then `workshopRoot`. So for one item id, its own copy wins over the
copy the Steam client downloaded.

**`gamecrate clean` cannot reclaim `<dataRoot>/steam`.** No tier reaches it, because it belongs
to no one profile. Delete the directory by hand when you need the space back.

### `workshopRoot`

`workshopRoot` is the directory the Steam client downloads workshop items into. The path is
`<steam library>/steamapps/workshop/content/<appId>`, and RimWorld's `appId` is `294100`:

```yaml
workshopRoot: ~/.steam/steam/steamapps/workshop/content/294100
```

**A plugin leaves it `null`.** Where Steam put your library is a fact about your machine, not
about the game, so no plugin guesses it. The key still has to appear in the merged config, and
`null` is the value a plugin ships.

A null root costs you nothing but the Steam client's own copies, because gamecrate downloads
its own. It is not a cause of failure, so nothing reports it. When a workshop item does not
resolve, the message names the item, not this key:

```
no mod matches "workshop:2009463077"
```

Read the download warning printed with it for the reason. A failed download and a mod whose manifest
does not parse both land here.

For a game with workshop ids, `doctor` prints which `steamcmd` it would run and the download
root, marking it when it does not exist yet.

The workshop scan is cached under `$XDG_CACHE_HOME/gamecrate`, or `~/.cache/gamecrate`. The key
covers the `appworkshop_<appId>.acf` file under every root. For the download root it reads the
file's contents. For `workshopRoot` it reads the size and modification time. A new download
changes that key and refreshes the scan. gamecrate scans local roots again on every launch.

## Git sources

gamecrate clones a git entry into a cache under the data root, one directory per repository and
ref:

```
~/.local/share/gamecrate/sources/<repo>-<hash>/<kind>-<ref>-<hash>/
```

`<repo>` is the last path segment of the URL, lowercased. The hash comes from the URL after
normalizing it: gamecrate drops a trailing `/` or `.git`, and the scheme and host lose their case.
So `https://github.com/a/b` and `https://github.com/a/b.git` share one clone. An SSH URL and an
HTTPS URL for the same repository do not, by design. `<kind>` is `branch`, `tag`,
or `commit`.

**That cache belongs to gamecrate.** A fetch runs `git reset --hard` inside it, which throws
away whatever you changed there, with no prompt, no warning, and no copy. To work on a mod,
clone it yourself and pin that checkout with `path:`.

Nothing evicts the cache. Move a pin from `v1` to `v2` and both clones stay on disk.

Only one gamecrate touches a clone at a time. A second one waits up to 30 seconds for the lock,
then fails with `another gamecrate is using <dir>` and exit `5`, naming the lock file it waited
on. gamecrate takes over a lock whose holder has died rather than waiting on it. The lock covers
the fetch and the build that follows it, not the whole session. Once a run is inside the
container, another launch can fetch and reset the same clone under it.

### Moving pins and fixed pins

An entry with no `branch`, `tag`, or `commit` follows the remote's default branch. Every launch
asks the remote for that branch, fetches it, and resets the clone onto it. So an unpinned entry
re-resolves on every run, and a push upstream reaches your next launch. A `branch` pin fetches
the same way, without the question.

A `tag` or `commit` pin clones once and then sits still. No launch fetches it again.
`gamecrate mods sync` is the only thing that moves a fixed pin.

A fetch that fails is a warning, not a failure. gamecrate keeps the clone already on disk and
says how old it is:

```
warning: could not fetch https://example.com/mod.git, using 4f9c21e from 3d ago
```

**A commit pin needs the server's cooperation.** gamecrate runs `git fetch origin <sha>`, which
asks for one commit by name. That works over `file://` and against GitHub. Other hosts answer
it only with `uploadpack.allowReachableSHA1InWant` turned on. A forge without that setting
turns every sync of the pin into the preceding warning, even while the remote is healthy. Pin a
`tag` instead when your forge refuses.

`--dry-run` and `--print-plan` never fetch and never clone. They do still ask a remote for one
thing: the default branch of an unpinned entry, through `git ls-remote`. A remote that cannot
answer fails the command with `could not read the default branch of <url>` and exit `5`. Past
that point, with no clone on disk, they stop with `no clone of <url> on disk` and exit `4`.

`gamecrate mods <game>`, `verify` and `doctor` ask no remote at all. They read the cache alone,
so a git pin with no clone yet reads as `no mod matches "<id>"`. An unpinned entry with two
default-branch clones on disk is left to the scan, which picks the newer one.

A launch never fetches a git mod that only a `match:` glob reaches. Expanding a glob needs the
index, and the index needs the clone. `mods add --git` clones, so the
first launch after it already has the tree.

`git` missing from `PATH` fails with `git is not on PATH` and exit `5`. Every git operation
shells out, so your SSH keys and credential helpers work as they do in a terminal.

### A clone is source, not a release

Most mod repositories keep their build output out of git. A clone of one carries `.cs` sources
and no assembly, which is exactly what the stale check looks for. Under the default
`--build auto`, the first launch runs `dotnet build` against the mod's `.csproj` or `.slnx`.
A mod with no C# at all is never stale, so nothing builds.

**So a git-pinned C# mod needs a working `dotnet` SDK on the host.** A failed build stops the
launch and exits `5`. gamecrate never starts a game whose mod failed to compile.

Two ways out when you have no compiler. Set `build: never` on the profile, or pass `--no-build`
for one run. The mod then loads with whatever assemblies the repository ships, which may be
none.

The build only looks in the mod directory itself for a `.csproj` or `.slnx`. A project that
lives under `Source/` is never built, and never fails either. The stale warning still fires.

## Worktrees and `--use`

A linked git worktree is a second checkout of a repository you already have. gamecrate never
picks one up by accident: it only counts when you pass `--worktree <path>`, export
`GAMECRATE_WORKTREE`, or run from inside it. A selected worktree's mods outrank every other copy
of the same ids. The run gets its own instance named `<dirname>-<hash>`, so its saves, lock,
and container stay apart from the profile's.

`--no-worktree` turns all of that off. It ignores the current directory, `$GAMECRATE_WORKTREE`,
any `--worktree` flag you also typed, and an instance's configured `worktree`. Setting
`GAMECRATE_WORKTREE=off` reads as unset.

`--use <packageId>=<path>` forces one mod to load from a directory, whatever the profile or
the library says. It is the only override that reaches a mod already in `preCore`, `core`, `dlc`
or `base`. The directory must hold the manifest and declare the id you named, or the launch
fails and tells you what it found there.
