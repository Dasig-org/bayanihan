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

**Not yet:** signing completed records with the group key, export endpoints (`/Person/{id}/$export`), short references (`LU-24`), files storage.
