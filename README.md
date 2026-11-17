# Goodfork

Goodfork is an iOS-first restaurant community built with React Native and Expo. Discover places through reviews and short videos, save restaurants, keep a private dining journal, and share public reviews. Verified restaurant managers can maintain listings, publish opening hours, and respond to feedback.

The app includes restaurant and dish search, map discovery, personal rankings, follows, comments, reporting, and optional AI assistance for dining suggestions and owner response drafts. Email/password and Google sign-in are supported in connected builds.

Goodfork is a functional prototype with local sample data and a connected Go API. Cloud deployment and native-device release checks are documented in the [deployment guide](docs/deployment.md).

## Repository layout

```text
App.tsx                 App entry, navigation, and tabs
src/
  screens/              Diner and restaurant-owner screens
  components/           Shared interface and media components
  services/             Typed HTTP and local sample implementations
  state.tsx             Session state and resource updates
assets/                 App icons and sample food media
server/
  cmd/goodfork/         API server and operations CLI
  internal/goodfork/    Domain logic, SQL migrations, and tests
  examples/             Fictional restaurant import data
  grants.sql            Database role permissions
  bootstrap-iam.sh      Google Cloud identity setup
scripts/                Contract and browser verification
docs/                   Deployment, testing, artwork, and review history
```

## Architecture

React Native screens use a shared typed service interface backed by either device-local sample storage or the Go HTTP API. The API handles authentication, permissions, discovery, reviews, private visits, business ownership, and moderation.

The deployment targets Cloud Run for the stateless Go service, Neon Postgres for persistent data, and a private Google Cloud Storage bucket for uploads. Media access passes through the API's visibility checks. Database roles distinguish runtime, operator, and cleanup access. Optional AI providers use a bounded server-side interface with explicit opt-in and local fallbacks.

## Setup

### Run the sample app

Install Node.js 24 and pnpm 11.25, then run from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm run web
```

Leaving `EXPO_PUBLIC_API_URL` unset enables sample mode. It includes fictional restaurants and persists changes on the current device.

For an iOS development build, install Xcode 26.4 or later, an iOS Simulator runtime, and CocoaPods, then run `pnpm run ios`. Android development uses `pnpm run android` with an installed Android SDK. Android maps require `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`.

### Run the connected app

Install Go 1.27 and start Postgres 17. Create the local database, then start the API from `server/`.

```sh
createdb -h localhost goodfork
cd server
export APP_ENV=local
export DATABASE_URL='postgresql://localhost:5432/goodfork?sslmode=disable'
export WEB_ORIGIN='http://localhost:8081'
go run ./cmd/goodfork migrate
go run ./cmd/goodfork import-places examples/restaurants.json
go run ./cmd/goodfork serve
```

In another terminal, run from the repository root.

```sh
EXPO_PUBLIC_API_URL=http://127.0.0.1:8080 pnpm exec expo start --web --port 8081
```

Local mode binds the API to loopback, stores media locally, and prints signup verification codes in the API console. For the iOS simulator, use the same API URL with `pnpm run ios`. Other devices need an API origin reachable from the device. `WEB_ORIGIN` must match the browser app's origin.

Production configuration, Google OAuth, SMTP, private storage, cloud IAM, and signed mobile builds are covered in the [deployment guide](docs/deployment.md). Keep backend credentials in the server environment or Secret Manager.

## Verification

```sh
pnpm run typecheck
pnpm run test:contracts
```

See the [testing guide](docs/testing.md) for PostgreSQL integration tests, platform exports, and sample and connected browser checks. Design reviews and implementation records are in [docs/reviews](docs/reviews).
