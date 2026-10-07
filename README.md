# Humlab/VISP Web Speech Recorder Ng Server

Server for the WebSpeechRecorderNg angular module, found at https://github.com/IPS-LMU/WebSpeechRecorderNg

This server is written in JavaScript and uses MongoDB as a backend. It also needs a file area on the server to upload wav files to.

# Installation

## Prerequisites

1. Node.js 24 or newer with npm (`package.json` declares `engines: node >=24`). The
   deployment image pins `node:24.16.0-alpine3.22`. The code itself is ESM
   (`"type": "module"`), uses modern syntax (`??=`) and `node --test`, so older Node
   versions will not work.

1. `git clone https://github.com/humlab-speech/wsrng-server`
1. `cd wsrng-server`
1. `npm install`
1. Copy the file .env-example to .env
1. Edit .env and enter your MongoDB info. Also check that the other settings are to your liking:

   | Key | Meaning |
   |:---|:---|
   | `MONGO_USER` / `MONGO_PASSWORD` / `MONGO_HOST` / `MONGO_PORT` / `MONGO_DATABASE` | MongoDB connection |
   | `SERVER_PORT` | HTTP port; no built-in default — if unset the OS picks a random port, the example file uses `8080` |
   | `AUDIO_FILE_STORAGE_PATH` | Root of the uploaded-wav area. In the VISP deployment this is `/repositories` (an absolute path); the default relative `audio` directory is only usable for standalone runs |
   | `ENABLED_MODULES` | JSON array of modules to load, e.g. `["visp"]` |
   | `LOG_PATH` | Log file path (relative to the install dir) |
   | `RESOURCES_PATH` | Currently unused — the images feature hard-codes a relative `resources/` path |

1. Setup your application so that all the WebSpeechRecorderNg API calls are routed to this server's address and port. Exactly how to do this depends on what the rest of your infrastructure looks like.

    For example, we are running our WSRNG-client on the web-path /spr and have it setup to route the API calls (all calls made to `/spr/api/v1/*`) to our WSRNG-server via an Apache Location directive like this:

    ```
    <Location /spr/api/v1>
        RequestHeader set X-Forwarded-Proto https
        ProxyPreserveHost On
        ProxyPass         http://wsrng-server:8080
        ProxyPassReverse  http://wsrng-server:8080
    </Location>
    ```
    Here 'wsrng-server' is the hostname of our server since it is run within the same docker cluster.

1. Run `npm start` or `node src/main.js`

## Endpoints

All routes are relative to the proxy root (the Apache `Location` above strips `/spr`). There
are exactly nine routes:

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/script/:scriptId` | Fetch a recording script (`findOne` on the `scripts` collection — no validation; scripts are created out-of-band) |
| `POST` | `/session/new` | Create a recording session (project + session id validated, see security rules) |
| `GET` | `/session/:sessionId` | Fetch a session record by session id |
| `GET` | `/project/:projectName` | Fetch project config — **auto-inserts** a default project document when none matches (see known issue below) |
| `GET` | `/project/:projectName/session/:sessionId/recfile` | List recorded takes (recfiles are stored under `project`/`session` keys) |
| `GET` | `/project/:projectName/session/:sessionId/recfile/:itemCode/:version` | Fetch a take's audio; `:version` `latest` selects the newest take |
| `POST` | `/session/:sessionId/recfile/:itemCode` | Upload a recorded wav take |
| `PATCH` | `/project/:projectName/session/:sessionId` | Progress-only update (see security rules) |
| `GET` | `/project/:projectName/resources/images/:imageFile` | Script-referenced images from the `resources/` directory |

## Security rules

- **Project / session ids** follow a deny policy: rejected only if empty, longer than 128
  chars, containing `/`, `\`, NUL, `..`, or equal to `.`/`..`. Spaces and unicode are allowed.
- **Item codes** follow a strict whitelist: `[A-Za-z0-9_-]{1,100}`.
- **`PATCH` on a session** only accepts progress fields
  (`status`, `loadedDate`, `startedDate`, `completedDate`, `restartedDate`). All other
  fields are dropped and logged; `script`, `sealed`, and identity fields are explicitly
  not patchable — a session that holds takes cannot be re-pointed at another script.
- All file paths are constructed under `AUDIO_FILE_STORAGE_PATH` with traversal guards.

Uploads land at
`<AUDIO_FILE_STORAGE_PATH>/<project>/Data/speech_recorder_uploads/emudb-sessions/<sessionId>/<itemCode>/<take>.wav`.

# Handler modules

You can write modules which can extend the functionality of this server. There is such a
module for the VISP system (in `src/handler_modules/visp.js`). When enabled it:

1. relocates **every** uploaded take as it arrives to
   `/repositories/<project>/Data/speech_recorder_uploads/emudb-sessions/<sessionId>/<itemCode>.wav`
   — the directory session-manager imports from; and
2. POSTs a best-effort *hint* to `http://session-manager:8080/api/importaudiofiles`
   (3 retries at 2 s / 10 s / 30 s, with a 5 s settle window coalescing upload bursts) once
   the session is completed. The hint only makes session-manager scan sooner — its own 30 s
   directory scan is the source of truth, so a lost hint delays an import but never loses it.

If you wish to run this server together with the rest of the VISP system you probably want to
enable it by adding "visp" to the `ENABLED_MODULES` array in the .env file.

# Tests

`npm test` runs `node --test test/*.test.js` — a new test file named `*.test.js` under `test/` is
picked up automatically.

# Known issues

- `GET /project/:name` **auto-inserts** a default project document when the lookup misses,
  and the lookup compares `parseInt(name)` against documents stored with `name` as a
  *string* — so numeric-named projects re-insert on every GET. Left unfixed deliberately
  (upstream behavior); do not rely on GET /project being side-effect free.
- `npm run docker-start` references the pre-quadlet `visp_visp-net` compose network and is
  stale in the Podman deployment; use the deployment repo's `visp.py` instead.
