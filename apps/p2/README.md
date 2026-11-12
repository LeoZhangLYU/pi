# p2

> [!WARNING]
> # EXPERIMENTAL
> **p2 is a prototype. It will be gone soon.** It is not supported, its data formats and APIs change without notice,
> and it will be replaced. Do not build on it or run it for anything you depend on.

A self-hosted Pi Durable UI built from independent [Chord](../../packages/chord) plugins. Owners have full agent and
shell control on that server and its workers; this is not server-side filesystem isolation. The Web UI is the only
client.

## Run

Requires Node 22.19+ and the monorepo's installed dependencies and model data. From the repository root:

```sh
npm install --ignore-scripts
npm run hydrate:model-data
cd apps/p2
npm start
```

Open http://127.0.0.1:8788 and sign in with the owner account. Set it on the first start with
`P2_USERNAME`/`P2_PASSWORD` (see below), or run `npm run set-password` and open `/owner`. The startup `p2: recovery
token (…): <token>` line is the escape hatch if the password is lost.
`PORT` changes the port; `P2_DATA_DIR` changes the default data directory `~/.pi/p2`.
`P2_FAKE=1 npm start` uses a fake provider for demos, but tools still act on real files.
See [development notes](docs/p2-notes.md) for dev mode, architecture and testing.
Code mode scripts can orchestrate one-shot agents (`tools.agent`); [docs/workflows.md](docs/workflows.md) has workflow
patterns with example scripts (fan-out with adversarial verification, drafts plus a judge, fix until a check passes,
search until nothing new).

## Signing in on this machine

Loopback alone proves nothing: on a machine with several users, any of them reaches `127.0.0.1:8788`. The owner is
whoever has the owner password or can read the server's private data directory (0700; its `owner-key` is 0600):

- **Owner account:** sign in at `/owner` with the owner username and password. Create the first one by starting the
  server with `P2_USERNAME` (default `owner`) and `P2_PASSWORD`, which write `<P2_DATA_DIR>/owner-account.json` (0600,
  scrypt hash) only when no account exists; or run `npm run set-password [username]` (password from `P2_PASSWORD` or
  stdin). The sign-in cookie lasts 30 days and each app load renews it, so a browser in use stays signed in. A browser
  without it gets the sign-in page (`/health` stays open).
- **Recovery token (escape hatch):** the one-time token the server prints at startup (valid ten minutes) or a fresh
  link from `npm run owner-link -- http://127.0.0.1:$PORT`. Paste the token at `/owner`, or open the link. Redeemed on
  loopback, it gives a local owner session (`access: "local"`): it may mint owner links and use loopback provider
  sign-ins. Use it when the password is lost.
- **`npm run owner-link`, `scripts/verify-sessions.ts`:** they sign in by themselves with the owner key of the data
  directory (`P2_DATA_DIR`, default `~/.pi/p2`), which must be the running server's: run them as the server's user,
  with its `P2_DATA_DIR`. Otherwise they say which directory did not match. The key never leaves the client: the
  server sends a one-time challenge, and the client answers with an HMAC of it and the server's port, so whatever
  listens on that port (another user's process while p2 is down) cannot replay the answer.
- **Radius** authenticates its relayed requests itself and needs none of this.

Changing the password (another `npm run set-password` or `P2_PASSWORD` write) regenerates the account's session
generation: password-issued sessions end on their next request, while owner-link and owner-key sessions stay valid.
Already-open WebSockets from an old password session persist until they reconnect.

**Remaining risk:** browser cookies are not port-scoped, so a browser holding the session cookie sends it to any
`127.0.0.1:<port>` page it opens, including another local user's server. That cookie is a session, not the key: sign
out this device to end it. Use a separate browser profile for untrusted local servers.

## Using the owner UI from another device

The server listens only on loopback. Use an HTTPS tunnel or reverse proxy preserving the public Host header, and
list its hostname in `P2_ALLOWED_HOSTS` (comma-separated for several hosts).

Open `https://your-domain/owner` on the other device and sign in with the owner username and password. On a remote
origin the password session is a Secure device session: it cannot mint recovery tokens. To invite the device with a
recovery link instead, on the host with `PORT` matching its running server:

1. On the host, with `PORT` matching its running server:

   ```sh
   npm run owner-link -- https://your-domain
   ```

   The base defaults to `P2_PUBLIC_URL`, or `http://127.0.0.1:$PORT` (8788 when unset). The command signs in as the
   local owner with the data directory's `owner-key` (see above), so only the server's user can run it.
2. Open the printed `https://your-domain/owner#<token>` link on your other device. The page removes the fragment,
   POSTs its token on the same origin, then redirects to `/`. The fragment never reaches HTTP/proxy logs.

Links work once and expire after ten minutes. Treat their output as a private credential: do not publish it or
put the token in a query/path. The private `<P2_DATA_DIR>/owner-token.txt` startup token works the same way; paste
it at `/owner`.

Owners get distinct signed, HttpOnly, SameSite=Lax cookies, Secure on a remote HTTPS origin. Cookies last 30 days
(server-side expiry too), are port-scoped, and survive restarts through the private `owner-key`. Devices signed in
on a remote origin are remote owners (`access: "device"`), so provider login and SSH-key upload work but owner-token
minting does not; only local owners can mint invitations. Radius
remains a separate authenticated owner transport; a proxy marker is never authentication.

**Devices → Sign out this device** revokes this cookie, including its live connections (a local session's links
stay: local sessions share one principal); other devices stay signed in. Individual revocations persist in private
`owner-revoked.json`. Already-admitted agent work continues.

The first deployment of signed cookies rotates the former raw-key cookie secret once (`owner-cookie-version`):
old raw-key cookies intentionally stop working. Generate fresh owner links after deploying. Outstanding invitations
do not survive server restarts; a fresh headless token replaces `owner-token.txt`. Compatible plugin reloads retain them.

## Providers and SSH keys

**Providers** is available to every owner (local, associated device or Radius). Provider-owned
pi-ai flows support API keys and OAuth; credentials stay in the server's private `auth.json`. Remote connections prefer
device-code methods where offered. For a browser-callback flow, complete sign-in in the provider tab and paste its
code or final redirect URL into Providers. If OpenAI ChatGPT lands on an unreachable localhost page, copy its entire
address from the address bar and paste it; the page need not load. Anthropic displays a code to paste. The provider's
registered callback URL is unchanged.

**Envs → Upload private key** also works for every owner, locally or remotely. Keys must be passphrase-less
and at most 16 KiB; they are stored privately under `<data>/ssh/keys/`, never returned to a browser. Key generation
and fetching an existing public key are available to every owner too. See [remote environments](docs/remote-envs.md).

API keys, pasted login codes and uploaded SSH keys pass through your tunnel or relay. Use a trusted transport.
Keep the data directory, owner-key/tokens/revocations, provider credentials and SSH keys private; never commit them.

## Deploy behind a proxy (no HTTP basic auth)

Keep p2 loopback-only. Preserve the public Host header and forward WebSocket upgrades. Configure
`P2_ALLOWED_HOSTS=your-domain` and `P2_PUBLIC_URL=https://your-domain`. Overwrite `X-P2-Proxy-Secret` on **every**
request with a constant marker, for example `1`. The historical header name remains, but its value has no authority
and `P2_PROXY_SECRET` is no longer used. Any marked/forwarded localhost request is rejected rather than receiving
device privileges, even when a Unix-socket bridge makes its network peer `127.0.0.1`. Allowed public hosts are
remote regardless of the marker; without an owner cookie visitors get only a minimal sign-in page and no
application assets, sessions, WebSockets or file/upload access.

Example Caddyfile behind an existing HTTPS front end (the Unix-to-loopback bridge is unchanged):

```caddyfile
:80 {
    reverse_proxy unix//p2/p2.sock {
        header_up X-P2-Proxy-Secret 1
        flush_interval -1
    }
}
```

Remove `basic_auth` and the old secret injection. Do not rewrite the public Host to localhost. Ensure the public
front end actually uses HTTPS; p2 treats allowed public hosts as HTTPS origins. Restart p2 to apply runtime/auth
changes, then reload the proxy and mint a fresh owner link. Do not run competing servers against the same data dir.

## Configuration

Edit `<P2_DATA_DIR>/settings.json` as a file; there is no Settings editor UI. Valid changes hot-reload without a
restart, and in-flight requests keep their configuration. Set the default model and thinking level with
**Make default for new sessions** in the model picker. `ownerName` (1 to 40 characters, no control characters, `<`
or `>`; default "Owner") is the name your messages carry from then on; messages already written keep theirs.
`detail` (1 to 4, default 2) is how much of a turn the web chat shows: 1 only the answer, with the thinking, the
agent's texts and its tool calls on one wheel per turn; 2 the texts too, thinking and calls on wheels between them;
3 thinking too (collapsed), only runs of tool calls on wheels; 4 thinking in full and each tool call as its own row,
no wheels.

### Projects

A project is one codebase in several places, one per environment. `<P2_DATA_DIR>/projects.json` lists them:

```json
{ "pi": [{ "env": "mac", "path": "~/projects/pi/pi" }, { "path": "~/projects/pi/pi" }] }
```

Object order is display order; array order is preference. A place without `env` is this device; `path` is absolute or
starts with `~` (that machine's home); a project has at most one place per environment. p2 watches the file: valid edits
apply at once, an invalid one keeps the last valid projects and shows why. Projects are owner-only. The Web UI has no
project picker; the `conversations` tool lists projects and can create a session in one:

- A session belongs to a project only when it was created there, or copied (`/clone`, `/fork`) from a session that
  does. Its folder does not matter: a new session from the Web never puts it in a project, and moving it keeps its
  project. p2 stores this itself (not in projects.json).
- A session whose project was removed from projects.json keeps the old name and groups again once the project is back.

`cacheWarming` (`"idle"` by default, `"streaming"` or `"off"`) keeps prompt caches warm as pi does: before the cache
entry of a conversation's last request expires (5 minutes for Anthropic and Claude on Radius), p2 sends the request
again with a one-token answer, while that is cheaper than writing the cache again. `"streaming"` warms while a run
streams (up to an hour, e.g. during a long tool call); `"idle"` also warms the main conversation for up to 30 minutes
after its run answered. The refreshes count in the conversation's cost. `stream.cacheRetention: "long"` writes 1-hour
cache entries instead (at twice the input price).

### Voice mode

Voice mode talks to the agent hands-free: the microphone button in the composer (owner only) streams your speech to a
speech service, each finished utterance becomes a message, and the agent's answers are read aloud sentence by sentence.
Talking over an answer stops it; "stop" also stops the agent. While it is on, the conversation's prompt asks for short
spoken answers. The button appears only when `<P2_DATA_DIR>/voice.json` names a speech service:

```json
{ "url": "https://voice.mariozechner.at", "token": "<the service's VOICE_TOKEN>" }
```

p2 watches the file: writing, replacing or removing it shows or hides the button in open pages at once, and the
service's engines and voices are fetched again on each change (the token stays on the server).

The speech service is `voice-server/` (Python, CPU only). Speech to text: Silero VAD and Parakeet TDT 0.6B v3, with
750 ms of audio before the detected speech start kept (`VOICE_VAD_PREROLL_MS`) so quiet first words survive.
Speech: selectable engines, listed with their voices by `GET /voices`: Supertonic 3 (default; voices F1-F5, M1-M5),
Kokoro and Kyutai Pocket TTS. Voice ids are `<engine>-<voice>`, for example `supertonic-F1` or `pocket-alba`. The
`/speak/stream` WebSocket sends 16-bit PCM chunks as they are generated: Pocket TTS streams ~80 ms chunks (first audio
after ~50-80 ms on slayer), Supertonic and Kokoro send a chunk per sentence (~0.2 s). `POST /speak` returns a WAV.
`server.py`'s docstring specifies the protocol. On slayer the service runs from `~/voice.mariozechner.at` (`docker
compose up -d`, token in `.env`); rebuild with `docker build -t p2-voice apps/p2/voice-server`. Browsers never reach
it directly: p2 proxies `/voice/listen` (WebSocket) and `/voice/speak` for the signed-in owner.

## Tests

```sh
npm run check
npm test
```

Tests use fake providers, temporary data/workspaces and port 0. Browser tests use `CHROMIUM_BIN`; daemon/SSH tests
skip when their prerequisites are unavailable. On Android (Termux) browser tests are skipped unless `P2_BROWSER_TESTS=1`:
Chromium's processes plus a test's p2 server and workers exceed Android's limit of 32 child processes, and its phantom
process killer then kills processes, the running p2 included. `P2_BROWSER_TESTS=0` skips them elsewhere too. No real provider logins or paid requests are needed.
