# Workspace profiles

A workspace profile decides which built-in objects, and which packages, a
workspace gets. A workspace keeps the profile it was created with. The lists
and rules live in `src/objects/workspace-profiles.ts`; WorkspaceManager
applies them.

Without profiles every workspace got the same set: the agents, object
creation, the desktop UI, and every workspace-scope package. That is right for
a person's workspace and wrong for one that serves something else, such as one
organization's partition on a shared instance, which needs storage and web
exposure and should not carry agents that write and run code.

## The profiles

| Profile | Gets |
|---|---|
| `default` | Everything, as before: the agents, object creation, the desktop. Every package that names no profile. |
| `service` | `AbjectStore`, `SharedState`, `Console`, `CollectionStore`, `WebExposure`. No agents, no object creation, no desktop. |
| your own | Defined in `$ABJECTS_DATA_DIR/profiles.json` |

Every workspace also gets its registry, Storage and FileSystem, whatever the
profile.

The built-in per-workspace objects come in two lists. Infrastructure objects
(`INFRA_OBJECTS`: storage, sharing, notifications, the agents, object
creation, the knowledge base, web exposure and so on) are spawned when a
workspace comes up, whether or not it is the active one. UI objects
(`UI_OBJECTS`: the workspace's windows and taskbar) are spawned the first time
the workspace is shown.

## Desktop and headless

On the headless edition (`server/headless.ts`) there is no display, so a
workspace brings up its infrastructure objects and none of its UI objects,
whatever its profile lists. Profiles keep their UI lists, so the same data
directory opens with its windows again under the desktop edition.
NotificationCenter is infrastructure: it keeps a workspace's notification
history and announces each one (a terminal shows them) with or without a
display, and draws a toast only where there is a desktop.

## Defining a profile

`$ABJECTS_DATA_DIR/profiles.json`, beside `packages.json`:

```json
{
  "profiles": {
    "org": {
      "description": "One organization",
      "objects": ["SharedState", "WebExposure"]
    }
  }
}
```

- A profile name is lowercase letters, digits, `-` and `_`, starting with a
  letter or digit, up to 64 characters.
- `objects` lists built-in per-workspace objects by name (the full list is
  the `default` profile's, from `listProfiles`). `AbjectStore` is always
  added: it is how a workspace persists its objects and package data.
- Order does not matter; objects are spawned in their dependency order. UI
  objects in the list are spawned the first time the workspace is shown, the
  rest when it comes up.
- A profile that lists an object without what it needs at startup is
  refused, with the reason (for example `Taskbar needs AppExplorer,
  ChatBrowser, JobBrowser, PeersViewer`). So is an unknown name.
- `default` and `service` cannot be redefined.
- A malformed file or profile is reported (`listProfiles` returns the
  problems, and the log shows them) and left out; the instance still boots.

The file is read when a workspace is created or restored, so a new profile
needs no restart to use.

## Packages join profiles

A workspace-scope package names the profiles it joins in its `abject.json`:

```json
{ "name": "OrgPortal", "scope": "workspace", "profiles": ["org"], … }
```

A package that names none joins `default` only, as before. To join `default`
as well, list it. `profiles`, when present, must be a non-empty list of
profile names. System-scope packages run once per instance and take no
profiles: a system-scope package that lists some is refused.

## Creating a workspace with a profile

By message to `WorkspaceManager`:

```js
await this.call(this.dep('WorkspaceManager'), 'createWorkspace', { name: 'Acme', profile: 'org' });
await this.call(this.dep('WorkspaceManager'), 'listProfiles', {});
```

Or through the terminal gateway that the `abject` command talks to
(`ws://127.0.0.1:<CLI_PORT>`, default `WS_PORT+4`, so 7723):

```json
{ "id": 1, "op": "createWorkspace", "name": "Acme", "profile": "org" }
{ "id": 2, "op": "listProfiles" }
```

The `abject` chat's `/ws new <name>` creates a `default` workspace.

`listWorkspaces` reports each workspace's profile. Workspaces created before
profiles existed are `default`.

## Restarts and recovery

A workspace comes back with its own profile. If its profile is no longer
defined, the workspace is **not** brought up under another one (an
organization's partition must not suddenly gain the agent stack): it is left
down, logged as an error, and kept on the saved list until the profile is
defined again. A workspace rebuilt after a worker crash gets the objects its
profile named when the workspace came up.
