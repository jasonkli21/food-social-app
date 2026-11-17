# Testing

Run the client checks from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:contracts
pnpm run export:ios
pnpm run export:web
pnpm exec expo export --platform android
```

The client contract suite shares hours fixtures with Go and SQL, covering timezone transitions, overnight service, date exceptions, intent handling, and malformed responses.

## Go integration tests

Use a disposable Postgres database. The suite creates and drops temporary schemas and role fixtures. Run from `server/`.

```sh
go vet ./...
GOODFORK_TEST_REQUIRED=1 GOODFORK_TEST_DATABASE_URL='postgresql://localhost:5432/goodfork_test?sslmode=disable' go test -race -count=1 -v ./...
```

Coverage includes schema upgrades, role-scoped operations, authentication and Google linking, journal isolation, hours, search evidence, concurrent ownership and moderation, request deadlines, uploads and orientation, media ranges, immutable reports, and optional provider privacy and fallbacks. `GOODFORK_TEST_REQUIRED=1` makes missing database configuration fail the integration run.

## Browser checks

The browser tests use Playwright with a mobile viewport and reduced motion. Install Chromium, or set `GOODFORK_CHROMIUM_EXECUTABLE` to a local Chrome executable.

```sh
pnpm exec playwright install chromium
pnpm exec expo export --platform web --output-dir /tmp/goodfork-demo
pnpm test:ui demo /tmp/goodfork-demo 8097
```

For the connected test, start the local API with a fresh disposable database imported from `server/examples/restaurants.json`, `WEB_ORIGIN=http://127.0.0.1:8098`, and a temporary `MEDIA_DIR`. Capture that API process's console output in its own mail log. Build the server binary from `server/` with `go build -o /tmp/goodfork ./cmd/goodfork`.

Run from the repository root with the API listening on port 8080.

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm exec expo export --platform web --output-dir /tmp/goodfork-connected
GOODFORK_TEST_API_URL=http://127.0.0.1:8080 \
GOODFORK_TEST_DATABASE_URL='postgresql://localhost:5432/goodfork_test?sslmode=disable' \
GOODFORK_TEST_BINARY=/tmp/goodfork \
GOODFORK_TEST_MAIL_LOG=/absolute/path/to/local-mail.log \
pnpm test:ui connected /tmp/goodfork-connected 8098
```

The connected flow creates fixture accounts, journal entries, a moderated photo review, and a verified owner. It exercises delayed submissions, response-loss retry, conflict recovery, opening hours, logout, and sign-in. Use fresh fixtures for each complete run.

## Dependency and release checks

Run `pnpm audit --prod` to check published dependency advisories. The [phase 3 review](reviews/phase-3.md#open-dependency-finding-f14) records the known picomatch finding at its verification date.

Native Maps, permissions, authentication callbacks, screen readers, video compatibility, and deployed Neon, Cloud Run, GCS, SMTP, and model providers require environment-specific checks. Release requirements and operations are in the [deployment guide](deployment.md).
