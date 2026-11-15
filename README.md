# Bayanihan Core and Bayanihan Server

> **Early and open.** v0.1, in pilot. The `@bayanihan/*` packages aren't on npm yet, so this repository expects [BIX](https://github.com/Dasig-org/bix) beside it:
>
> ```sh
> mkdir dasig && cd dasig
> git clone https://github.com/Dasig-org/bix.git
> git clone https://github.com/Dasig-org/bayanihan.git
> (cd bix && npm install)
> cd bayanihan && npm install
> ```
>
> To run the Dasig app as well, also clone [`bayani`](https://github.com/Dasig-org/bayani) and [`dasig-app`](https://github.com/Dasig-org/dasig-app) into the same folder; see the app's README.

The open engine and reference server for [BIX, the Bayanihan Information Exchange](https://github.com/Dasig-org/bix): an open format for the work of volunteer groups and civic organizations.

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) · `@bayanihan/core` | **Bayanihan Core**, the rules engine: lifecycles, permissions, first-come claims, signatures (Ed25519 over RFC 8785), counting votes, report figures. Pure logic: no storage, no network. |
| [`packages/server`](packages/server) · `@bayanihan/server` | **Bayanihan Server**, the reference BIX server, like HAPI for FHIR. Stores records (SQLite or Postgres), answers the BIX API, and runs Core on every change. |
| [`deploy/`](deploy) | One container plus Litestream backups and Caddy for HTTPS: how the hosted Dasig Ecosystem runs, and how you can run your own. |

The same server runs inside every phone running the [Dasig app](https://github.com/Dasig-org/dasig-app), on a group's hub phone over its hotspot, and on hosted servers.

## Run it

```sh
npm install
npm test
BIX_DB=./data/bix.db BIX_OPEN_JOIN=1 npm start -w @bayanihan/server   # http://localhost:8787/metadata
```

Self-host with Docker (SQLite, continuous backup to any S3-compatible storage, automatic HTTPS):

```sh
cd deploy && cp env.example .env   # fill in your domain and backup storage
docker compose up -d --build
```

See [`deploy/env.example`](deploy/env.example) for every setting.

## Status

v0.1, in pilot. The API follows FHIR's REST patterns; see the server's [README](packages/server/README.md).

## Licence

**Apache-2.0**, see [`LICENSE`](LICENSE). Maintained by Dasig Inc. Questions: hello@dasig.org.

## Credits

Philippine places (PSGC codes for regions, provinces, cities, municipalities and barangays) come from the **Philippine Statistics Authority**, as packaged by the open-source [barangay](https://github.com/bendlikeabamboo/barangay-api) project by Manuel B. (MIT). See `packages/server/data/PSGC_NOTICE.md`.
