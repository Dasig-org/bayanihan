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

## Run locally

```bash
# 1. Start Docker Desktop, then the local Supabase stack (Postgres on 54422, beside Dasig's stack on 54322)
supabase start
supabase db reset          # applies supabase/migrations
# 2. Start the server
npm run dev -w @bayanihan/server   # http://localhost:8787
```

**Local only:** `identify()` in `src/main.ts` trusts an `x-bix-person` header. Replace it with Supabase Auth, and resolve permissions with Core's `authorize()`, before anything leaves this machine.

**Not yet:** authentication, reads filtered by `authorize()`, signing completed records with the group key, export endpoints (`/Person/{id}/$export`), short references (`LU-24`), files storage.
