# Bayanihan Core and Bayanihan Server

**The open engine and reference server for [BIX](https://github.com/Dasig-org/bix), the Bayanihan Information
Exchange.** The same code runs on a volunteer's phone, on a group's hub phone with no internet, and on a hosted server.

> **Early and open.** v0.1, in pilot with a small number of volunteer groups in the Philippines. It runs the hosted
> Bayanihan Network behind the [Dasig app](https://github.com/Dasig-org/dasig-app) today, and it changes every week.

## What it does

BIX says what a group's records look like. This repository makes them behave:

- **Who may do what.** Permissions come from a person's role in the group. A private record you can't see answers 404,
  as if it doesn't exist.
- **What can happen next.** Lifecycles for steps, needs, offers, projects, reports and decisions. A step is claimed
  first come, first served; only the person asked can accept; money and people served need a second person.
- **A signed record of the work.** When work is confirmed, the group signs that exact version (Ed25519 over RFC 8785),
  so anyone can check who did what.
- **Figures nobody has to type.** Report figures, hours and project memory are calculated from confirmed records, with
  small numbers hidden in public.
- **Offline, then sync.** Changes made without internet are replayed in order when the phone is back online, and
  refused, never silently merged, if someone else got there first.

## The two packages

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) · `@bayanihan/core` | **Bayanihan Core**, the rules engine. Pure TypeScript: no storage, no network, no `eval`, so it runs on phones (Hermes) and servers alike, and the two can never disagree. |
| [`packages/server`](packages/server) · `@bayanihan/server` | **Bayanihan Server**, the reference BIX server, as HAPI is for FHIR. Stores records in SQLite or Postgres, answers the BIX API, and runs Core on every change. Also handles sign-in, files and push. |
| [`deploy/`](deploy) | One container with Litestream backups and Caddy for HTTPS: how the hosted network runs, and how you can run your own. |

```
 phone (Dasig app) ──┐
 hub phone on wifi ──┼── Bayanihan Server ── Bayanihan Core ── BIX schemas
 hosted network    ──┘        (stores)          (decides)        (shapes)
```

## Run it

To use Core or Server in your own project:

```sh
npm install @bayanihan/core      # the rules engine
npm install @bayanihan/server    # the reference server
```

To work on this repository you need Node.js 22.13 or newer:

```sh
git clone https://github.com/Dasig-org/bayanihan.git
cd bayanihan && npm install

npm run verify                                                        # typecheck + tests
BIX_DB=./data/bix.db BIX_OPEN_JOIN=1 npm start -w @bayanihan/server   # http://localhost:8787/metadata
```

Then try the API:

```sh
curl http://localhost:8787/metadata
```

The endpoints, sign-in, files, push notifications and Postgres setup are in the
[server README](packages/server/README.md). Core's modules are in the [Core README](packages/core/README.md).

To run the Dasig app against it, also clone [`bayani`](https://github.com/Dasig-org/bayani) and
[`dasig-app`](https://github.com/Dasig-org/dasig-app) into the same folder and follow the app's README.

## Host your own

A group, a federation or a city can run its own server. Docker, SQLite, continuous backup to any S3-compatible storage,
automatic HTTPS:

```sh
cd deploy && cp env.example .env   # your domain and backup storage
docker compose up -d --build
```

Every setting is explained in [`deploy/env.example`](deploy/env.example).

## Get involved

- **Pick up an issue** labelled [`good first issue`](https://github.com/Dasig-org/bayanihan/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/Dasig-org/bayanihan/labels/help%20wanted).
- **Add tests for Core.** Rules are pure functions, so tests are short and a good first contribution.
- **Self-host it** and tell us what was hard.
- **Review the security model** (permissions, signatures, privacy) and report problems privately via
  [`SECURITY.md`](SECURITY.md).
- **Questions:** [Dasig-org Discussions](https://github.com/orgs/Dasig-org/discussions).

Maintainers: how to publish the npm packages is in [`RELEASING.md`](RELEASING.md).

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before your first pull request. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Part of Bayanihan

[Bayanihan, an open initiative by Dasig](https://bayanihan.dasig.org):
[BIX](https://github.com/Dasig-org/bix) (the open format) · **Bayanihan Core and Server** (rules and storage) ·
[Bayani](https://github.com/Dasig-org/bayani) (a small on-phone model) · [Dasig](https://github.com/Dasig-org/dasig-app)
(the app).

## Licence

- **Bayanihan Core** (`packages/core`): **Apache-2.0**, see [`packages/core/LICENSE`](packages/core/LICENSE). Permissive,
  so any app or system can build on BIX's rules.
- **Bayanihan Server** (`packages/server`) and everything that runs it (`deploy/`, `supabase/`, `tools/`): **AGPL-3.0**,
  see [`LICENSE`](LICENSE) and [`packages/server/LICENSE`](packages/server/LICENSE). Anyone may run, change and host
  it; if you run a changed version as a service, you share your changes under the same licence. The same licence as
  the Dasig app.

The Server moved from Apache-2.0 to AGPL-3.0 on 2026-11-21. Releases and commits before that date stay available under
Apache-2.0. The Dasig name and emblem are trademarks of Dasig Inc.; forks need their own name. Maintained by Dasig
Inc. Questions: hello@dasig.org.

## Credits

Philippine places (PSGC codes for regions, provinces, cities, municipalities and barangays) come from the **Philippine
Statistics Authority**, as packaged by the open-source [barangay](https://github.com/bendlikeabamboo/barangay-api)
project by Manuel B. (MIT). See `packages/server/data/PSGC_NOTICE.md`.
