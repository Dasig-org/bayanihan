# Bayanihan Core

The engine that enforces BIX. One TypeScript package used by the Dasig app (on the phone) and by Bayanihan Server, so the two can never disagree about what's valid. Apache-2.0.

```sh
npm install @bayanihan/core
```

```js
import { validate } from "@bayanihan/core";

const { valid, errors } = validate(record);   // any BIX record
if (!valid) console.log(errors);              // [{ path, message }]
```

Signing lives at `@bayanihan/core/sign`, report figures at `@bayanihan/core/figures`, project memory at `@bayanihan/core/memory`. Node.js 22.13 or newer; also runs in Expo and browsers.

| Module | What it does |
|---|---|
| `validate` | Checks any record against its BIX v0.1 JSON Schema. Unknown types and unknown fields are refused. |
| `lifecycle` | Allowed state changes for Task, Need, Offer, Initiative, Role, Report, Decision, TaskDefinition, ShareLink, Consent |
| `rules` | `applyChange()`: the one place a change is allowed or refused. Version checks, propose-then-commit, claiming only for yourself, only the person asked can accept, a second person for money and beneficiaries, recorded when done. Returns the record and its Provenance. |
| `sign` | RFC 8785 canonical form, SHA-256, Ed25519 signing and verification of records |
| `figures` | Report figure rules (`count-tasks`, `sum-task-hours`, `sum-task-output`, `sum-received`, `sum-part-reports`) and small-number hiding |
| `vote` | Counts a Decision's votes: last vote per eligible voter before closing, quorum, thresholds, consent |

To work on Core, clone [the repository](https://github.com/Dasig-org/bayanihan) and run:

```bash
npm test -w @bayanihan/core
```

**Not yet:** resolving permissions from Roles, Positions and Teams; sharing checks (`authorize`); Bundles and offline replay; goal progress; mentions and references. Ed25519 needs WebCrypto support on the phone (check on Expo before relying on it).
