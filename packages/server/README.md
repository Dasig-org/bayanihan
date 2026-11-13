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

## Sign-in methods and email codes

A Person on a hosted server can have several ways to sign in: Google, an OIDC provider (for example Dasig.org), and
email with a one-time code. Each is a (provider, subject) pair linked to the Person, with the email shown in Settings.
A method is added only while signed in (`link: true`), so accounts are never joined because an email matches.

| Setting | What it does |
|---|---|
| `BIX_EMAIL_FROM` | Turns on email codes; the verified sender, e.g. `Bayanihan Network <signin@example.org>` |
| `BIX_EMAIL_SES_REGION`, `BIX_EMAIL_SES_ACCESS_KEY_ID`, `BIX_EMAIL_SES_SECRET_ACCESS_KEY` | Amazon SES, with credentials of their own |
| `BIX_NETWORK_NAME` | The name used in the email, e.g. `the Bayanihan Network` |

Endpoints: `POST /$email/start {email}` sends a 6-digit code (10 minutes, five tries, one per 30 seconds, ten per hour
from one address); `POST /$email/verify {email, code}` signs in or makes the account. `GET /$me/account` lists ways to
sign in (with their email), the phones and browsers signed in, and which method this one used; `POST
/$me/account/remove` removes a method (never the last one, nor the one this phone signed in with) or signs another
phone or browser out (`{device}`).

## Usernames and invitations

BIX "Usernames and invitations". `POST /$me/handle {value | null | findable}` claims, changes or drops a username (rules
in `src/invites.ts`: 3–20 lowercase letters, digits, `.` `_`, reserved words, one change every 30 days, released names
held 30 days). `GET /$handle/:value` finds a person by exact username only, returning nickname and photo.
`POST /$invite {target, role, handle | person | email, message}` sends an invitation (the core team, or everyone if
the group's `invitePolicy` is `members`); `GET /$invitations` lists yours; `POST /$invitations/:id {answer}` accepts,
declines, blocks or withdraws. Invitations and usernames never change through a plain bundle.

Privacy: an invited email is kept only as a salted hash (`BIX_INVITE_SALT`) until that address signs in, never in a
record or a response, and the answer is the same whether or not anyone uses it. Invitation emails go through the
sign-in SES sender (`BIX_EMAIL_FROM`); `BIX_APP_URL` is the app link in them.
