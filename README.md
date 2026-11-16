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

You need Node.js 22. The `@bayanihan/*` packages aren't on npm yet, so [BIX](https://github.com/Dasig-org/bix) sits
beside this repository:

```sh
mkdir dasig && cd dasig
git clone https://github.com/Dasig-org/bix.git
git clone https://github.com/Dasig-org/bayanihan.git
(cd bix && npm install)
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

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before your first pull request. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Part of Bayanihan

[Bayanihan, an open initiative by Dasig](https://bayanihan.dasig.org):
[BIX](https://github.com/Dasig-org/bix) (the open format) · **Bayanihan Core and Server** (rules and storage) ·
[Bayani](https://github.com/Dasig-org/bayani) (a small on-phone model) · [Dasig](https://github.com/Dasig-org/dasig-app)
(the app).

## Licence

**Apache-2.0**, see [`LICENSE`](LICENSE). Maintained by Dasig Inc. Questions: hello@dasig.org.

## Credits

Philippine places (PSGC codes for regions, provinces, cities, municipalities and barangays) come from the **Philippine
Statistics Authority**, as packaged by the open-source [barangay](https://github.com/bendlikeabamboo/barangay-api)
project by Manuel B. (MIT). See `packages/server/data/PSGC_NOTICE.md`.
