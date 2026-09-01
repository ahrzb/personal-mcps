# Add a tunneled app

From the add-app form to an online row. Rules: §13 (`/apps`), §6 (the
reverse connection), §2 (the two kinds).

## Wireframe map

| Journey moment | Artboard |
|---|---|
| Apps list | `Apps` / `MobileApps` |
| First run, nothing yet | `EmptyStates · Apps — empty` |
| Add form, tunneled branch | `AppNew` / `MobileAppNew`, `AppNewStates · TUNNELED` |
| Slug rejected | `AppNewStates · SLUG ERROR` |
| Token shown once | `AppNewStates · TOKEN REVEAL` |
| Delete confirm | `Dialogs · Delete app` |

## The journey

1. `/apps` lists active apps — kind, status (online/offline for
   tunneled), roles, last seen — with an add-app action; an archived
   section sits below with unarchive/delete (§13).
2. The form's first choice is the kind: **tunneled** or proxied (§2). Tunneled
   needs only the slug.
3. Creation shows the **app token once** (`AppNewStates` "App
   created") — there is no way to read it again, and the UI must say so. Losing
   it means disconnect/recreate.
4. Off-page, the author's server dials in with that token via a client library
   (§6, §11). The app's row flips to **online** and tracks last-seen; a
   dropped tunnel shows offline until it reconnects.

## States & edges

- Every mutation on `/apps` is a CSRF-tokened POST; destructive actions
  (delete) confirm first — `Dialogs` (§13).
- Archive hides an app from consumers (`-32002` on call, §7) without
  deleting its config; the archived section offers unarchive/delete.
- Status vocabulary is the wire vocabulary (`kind: tunnel`, online/offline)
  (§2, §13).
