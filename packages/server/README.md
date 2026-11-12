# Bayanihan Server

The reference BIX server, like HAPI for FHIR. Stores BIX records in Postgres, answers the standard BIX API, and runs Bayanihan Core on every change. Dasig is one client of it. Apache-2.0 when published.

| Endpoint | What it does |
|---|---|
| `GET /metadata` | What this server supports |
| `GET /{type}/{id}` | Read a record |
| `GET /{type}?field=value` | Search (v0: equality on fields and references) |
| `GET /{type}/{id}/_history` | Every version of a record |
| `POST /` with a `transaction` Bundle | Apply changes now; `409` with the current state if refused |
| `POST /` with a `sync` Bundle | Replay offline changes in the order they happened; refusals reported |
| `GET /{type}/{id}/$verify` | Check a record's signatures: who signed which version, and whether it's unchanged |
| `GET /$keys/{type}/{id}` | A group's or person's public key, for checking signatures anywhere |
| `GET /$ref/{ref}` | Find a record by its short reference, e.g. `/$ref/LU-24` |
| `GET /Person/{id}/$export` | Everything that names you, as a BIX Bundle. Only you. |
| `GET /Organization/{id}/$export` | Everything a group owns, as a BIX Bundle. Needs `org.manage`. |
| `POST /$files` | Upload a file (raw body, its content type, `?title=` and `?showsMinors=`). Returns a BIX Attachment. Up to 15 MB; images, PDF, Office files, text. |
| `GET /$files/{hash}` | Download a file: its uploader, or anyone who can see a record holding it. Photos showing children only for people in the group. |
| `POST /$me` | First sign-in: creates the caller's Person (a nickname is enough) and links the account |

## Run locally

```bash
# 1. Start Docker Desktop, then the local Supabase stack (Postgres on 54422, beside Dasig's stack on 54322)
supabase start
supabase db reset          # applies supabase/migrations
# 2. Start the server
npm run dev -w @bayanihan/server   # http://localhost:8787
```

**Sign-in.** Send a Supabase Auth access token as `Authorization: Bearer …`. The server verifies it, finds the linked Person (`bix_accounts`), and decides every read and write with Core's `authorize()` and `applyChange()`, using the roles of the group that owns each record. Private records you can't see answer 404, as if they don't exist. Published projects and groups return their public summary to anyone.

**Local testing shortcut:** `BIX_DEV_HEADERS=1 npm run dev -w @bayanihan/server` also accepts an `x-bix-person` header. Off by default; never enable it on a shared server.

**Signing.** When work is completed (or confirmed), the server signs that exact version with the owning group's Ed25519 key (a person's, for personal work), over its RFC 8785 form, and stores the signature on its Provenance. Private keys stay in `bix_keys`.

**Short references.** New Tasks, Needs, Offers and Decisions in a project get `{PREFIX}-{n}`. The prefix is the project's `bayanihan:ref-prefix` identifier (e.g. `LU`), or its initials and year.

**Creating records** is checked too: anyone may start a group (and becomes its officer by rule) or ask to join one; adding people needs `member.manage`; planning needs `initiative.plan`; team members may propose work as drafts; you can only vote, follow, consent or send as yourself.

**Files** are kept by this server, named by their SHA-256 (stored once, however often they're uploaded), on local disk at `BIX_FILES_DIR` (default `packages/server/.data/files`). An S3-compatible store (MinIO for self-hosting) uses the same interface next.

**Not yet:** S3-compatible file store, goal progress, mentions, the hub.

## Push notifications (optional)

A hosted server can tell people when something needs them: a task asked of them, someone asking to join a group or
team they run, an offer for a need. Messages are short and general ("Humans of Cebu asked you to help"); the detail
loads when the app opens, so no task text, place or group-only detail passes through a push service. Push targets are
kept per signed-in device, outside the BIX records: never synced, signed or exported, and removed on sign-out and when
a person asks to delete their account.

| Setting | What it does |
|---|---|
| `BIX_PUSH_VAPID_PUBLIC`, `BIX_PUSH_VAPID_PRIVATE` | Web push (installed web apps and browsers) with your own key pair: `npx web-push generate-vapid-keys` |
| `BIX_PUSH_SUBJECT` | A contact for push services, e.g. `mailto:you@example.org` |
| `BIX_PUSH_EXPO=1`, `BIX_PUSH_EXPO_TOKEN` | Send through Expo's push service, for an Expo app you publish (the token is your Expo access token) |

Endpoints: `GET /$push` (what this server can send, and its web key), `POST /$push` with `{kind: "web" | "expo", target}`
to register this device, or `{off: true}` to stop. A hub on local wifi has no internet, so it doesn't send push.
