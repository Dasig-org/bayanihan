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
| `GET /$ref/{ref}` | Find a record by its short reference, e.g. `/$ref/LU 2027-24` |
| `GET /Person/{id}/$export` | Everything that names you, as a BIX Bundle. Only you. |
| `GET /Organization/{id}/$export` | Everything a group owns, as a BIX Bundle. Needs `org.manage`. |
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

**Short references.** New Tasks, Needs, Offers and Decisions in a project get `{PREFIX}-{n}`. The prefix is the project's `bayanihan:ref-prefix` identifier (e.g. `LU 2027`), or its initials and year.

**Creating records** is checked too: anyone may start a group (and becomes its officer by rule) or ask to join one; adding people needs `member.manage`; planning needs `initiative.plan`; team members may propose work as drafts; you can only vote, follow, consent or send as yourself.

**Not yet:** files storage.
