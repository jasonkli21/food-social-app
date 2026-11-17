# Cloud Run deployment

## Mobile builds

The Expo app uses development builds. Run mobile build commands from the repository root. Local iOS builds require Xcode 26.4 or later, an installed iOS Simulator runtime, and CocoaPods. Android builds require the Android SDK and an Android Maps key through `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`. iOS uses Apple Maps.

```sh
pnpm run ios
pnpm run android
```

EAS-hosted builds require an Expo account and project. `eas build --platform ios --profile simulator` creates an iOS simulator build. For a signed release, configure the bundle identifier in `app.config.ts`, Apple signing, and the production `EXPO_PUBLIC_API_URL`, then run `eas build --platform ios --profile production`. The production API origin must use HTTPS.

Before a public iOS submission with Google login enabled, provide an equivalent sign-in option that meets Apple's privacy requirements. Verify the release candidate on a physical device for Maps, photo permissions, authentication callbacks, and video playback. [App Review Guidelines, section 4.8](https://developer.apple.com/app-store/review/guidelines/#login-services)

## Cloud prerequisites

Run the Google Cloud commands below from the repository root with an authenticated `gcloud` CLI. Use a Google Cloud project with billing enabled, a Neon database in a nearby region, a private regional GCS bucket, and an Artifact Registry Docker repository. The snippets assume Bash or zsh.

## Set up secrets and identities

1. Create the Neon database. Save its **direct** Postgres URL to a Secret Manager secret named `goodfork-neon-migrate`. Use `sslmode=verify-full` and keep `channel_binding=require` if supplied by Neon. Save a **pooled** URL with the same TLS parameters to the `goodfork-neon-runtime` secret. Use a dedicated runtime database role with table read/write privileges. Store a separate pooled URL in `goodfork-neon-cleanup` for a cleanup-only role. Set up their grants after applying migrations.
2. Enable Cloud Run, Cloud Build, Artifact Registry, Secret Manager, Cloud Storage and, if scheduling cleanup, Cloud Scheduler. Create service accounts named `goodfork-api`, `goodfork-migrate`, and `goodfork-cleanup`. Grant each account Secret Manager Secret Accessor on its own database secret. The cleanup account uses its own database secret.
3. Use uniform bucket-level access and public access prevention. Grant the API account Storage Object Viewer and Storage Object Creator on the bucket, and the cleanup account Storage Object User. The migration account needs no bucket access. Set any soft-delete retention period to match the published privacy policy. The bucket is never served directly to app users.
4. Set up an authenticated SMTP relay that supports STARTTLS on port 587. Verify the sender address with your relay and store its credential in `goodfork-smtp-password`. Goodfork sends a single-use verification code to confirm each new email account.
5. Create a Secret Manager secret named `goodfork-blocked-terms` with the terms and phrases you screen. Give the API identity access. Prepare the public URLs for the privacy policy and terms/community guidelines, and a support mailbox.

With the secrets and bucket in place, run `PROJECT=your-project BUCKET=your-bucket bash server/bootstrap-iam.sh` to apply the account and resource bindings. The app's own permissions distinguish public access, signed-in diners, and verified listing managers. The database checks ownership on each listing or reply write. Operators use restricted Google Cloud and Neon identities for verification and moderation.

[Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets), [Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity)

## Build, migrate, and deploy

```sh
export PROJECT='your-google-cloud-project'
export REGION='us-central1'
export REPO='goodfork'
export BUCKET='your-private-goodfork-media-bucket'
export POLICY_URL='https://your-domain.example/privacy'
export TERMS_URL='https://your-domain.example/terms'
export SUPPORT='support@your-domain.example'
export SMTP_HOST='smtp.your-relay.example'
export SMTP_USER='your-relay-username'
export SMTP_FROM='hello@your-domain.example'
export RELEASE='v1.0.0'
export IMAGE="$REGION-docker.pkg.dev/$PROJECT/$REPO/goodfork:$RELEASE"

gcloud builds submit server --project "$PROJECT" --tag "$IMAGE"

gcloud run jobs deploy goodfork-migrate --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --args=migrate --max-retries=1 \
  --service-account "goodfork-migrate@$PROJECT.iam.gserviceaccount.com" \
  --set-secrets DATABASE_URL=goodfork-neon-migrate:latest
gcloud run jobs execute goodfork-migrate --project "$PROJECT" --region "$REGION" --wait
```

Create the Neon roles referenced by [grants.sql](../server/grants.sql), substitute names if needed, and apply the file as the migration role after migrating. Grant the operator's DB role separately from Cloud Run. The API can insert audit events and the operator can read them. Cleanup can remove expired reports and audit rows. For existing installations, remove legacy default grants and review existing ACLs before applying these permissions.


```sh
gcloud run deploy goodfork --project "$PROJECT" --region "$REGION" --image "$IMAGE" \
  --execution-environment gen2 --allow-unauthenticated --concurrency 20 --max-instances 10 \
  --memory 512Mi --cpu 1 --timeout 75s \
  --service-account "goodfork-api@$PROJECT.iam.gserviceaccount.com" \
  --set-secrets 'DATABASE_URL=goodfork-neon-runtime:latest,BLOCKED_TERMS=goodfork-blocked-terms:latest,SMTP_PASSWORD=goodfork-smtp-password:latest' \
  --set-env-vars "GCS_BUCKET=$BUCKET,SUPPORT_EMAIL=$SUPPORT,PRIVACY_URL=$POLICY_URL,TERMS_URL=$TERMS_URL,SMTP_HOST=$SMTP_HOST,SMTP_USER=$SMTP_USER,SMTP_FROM=$SMTP_FROM"

gcloud run jobs deploy goodfork-cleanup --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --args=purge --max-retries=2 --task-timeout=15m \
  --service-account "goodfork-cleanup@$PROJECT.iam.gserviceaccount.com" \
  --set-secrets DATABASE_URL=goodfork-neon-cleanup:latest --set-env-vars "GCS_BUCKET=$BUCKET"
```

Unauthenticated Cloud Run invocation is required to serve public restaurant reviews. Goodfork authenticates account actions with its own tokens. The Cloud Run instances open at most eight connections each to the Neon pooler. The API validates uploads before writing to the private bucket. Media supports byte-range reads for playback.

Check `/healthz` and `/readyz` at the service URL, and test an upload, a moderation decision, and playback against the deployed service before inviting diners. Set the build environment variable `EXPO_PUBLIC_API_URL` to the service URL for EAS production builds.

## Enable sign-in with Google

Create a Web application OAuth client in Google Cloud. Add the deployed API's exact HTTPS `/v1/auth/google/callback` as the authorized redirect URI and configure the OAuth consent screen. Store the client secret in `goodfork-google-client-secret`.

```sh
export GOOGLE_CLIENT_ID='your-oauth-client-id.apps.googleusercontent.com'
export API_URL='https://your-cloud-run-service.run.app'
ENABLE_GOOGLE_LOGIN=1 bash server/bootstrap-iam.sh

gcloud run services update goodfork --project "$PROJECT" --region "$REGION" \
  --update-secrets GOOGLE_CLIENT_SECRET=goodfork-google-client-secret:latest \
  --update-env-vars "GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID,GOOGLE_REDIRECT_URL=$API_URL/v1/auth/google/callback"
```

Google sign-in requests OpenID identity, verified email, and basic profile scopes. The API verifies the token's signature, audience, issuer, and nonce. The app redeems a short-lived callback code bound to the device that started sign-in. Linking an existing verified email account requires its Goodfork password in Settings. The device finishes linking in the same valid Goodfork session with a matching signed Google email. Returning Google sign-ins use the provider subject. For the browser test build, configure the API's `WEB_ORIGIN` and serve the single-page app on that exact origin, including the `/auth/google` callback path.

[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect), [Expo authentication browser sessions](https://docs.expo.dev/versions/latest/sdk/webbrowser/)

## Operate the community

Run the following using an operator Neon URI and Application Default Credentials scoped to your private bucket. Run from `server/` and set `DATABASE_URL` and `GCS_BUCKET` in the shell without putting secrets in files or command history.

```sh
export GOODFORK_OPERATOR_PRINCIPAL='operator:your-non-secret-identifier'
go run ./cmd/goodfork import-places /path/to/licensed-restaurant-directory.json
go run ./cmd/goodfork queue
go run ./cmd/goodfork download-media MEDIA_UUID > /private/tmp/goodfork-moderation-media
go run ./cmd/goodfork moderate publish-post REVIEW_UUID REVIEW_REVISION
go run ./cmd/goodfork moderate publish-place RESTAURANT_UUID
go run ./cmd/goodfork audit
```

Production moderation requires `GOODFORK_OPERATOR_PRINCIPAL` for attributable decisions. Use the controlled operator execution identity for this value. Manager writes record the authenticated person automatically. The audit's person link clears on account deletion, and historical rows retain their legacy-unknown attribution.

Reports preserve bounded versioned evidence for reviews, comments, profiles, listings, and restaurant responses. Use `moderate hide-reported-post REPORT_UUID` or `moderate hide-reported-place REPORT_UUID` to act against the reported revision. A newer revision causes a conflict and requires a fresh inspection. The `hide-post` and `hide-place` commands intentionally act on current content. Dismiss obsolete reports explicitly. Evidence expires after 90 days and author-attributed evidence cascades on account deletion.

Deploy migration 006 and its grants before the new API and app. Public review edits and deletion now require the loaded revision. An older writer receives a conflict directing it to reload, and older public readers retain their fields. Private visits live in a separate table with authenticated, person-scoped endpoints. Operator and cleanup roles have no journal read grant.

The queue includes pending uploads, suggested restaurants, business claims, and reports. Verify claimants using the restaurant's published business contact information before running `moderate approve-claim CLAIM_UUID CLAIM_REVISION`. A claimant sees the decision in Restaurant tools. Use `decline-claim CLAIM_UUID CLAIM_REVISION` to decline a request or `revoke-owner RESTAURANT_UUID` to remove access. Claims never expose a business verification email in the app. Other actions include `hide-post`, `hide-place`, `remove-comment`, `remove-person`, and `dismiss-report`. To remove a restaurant response, run `moderate remove-reply REVIEW_UUID REPLY_REVISION` using the reported version. To restore an eligible hidden review, inspect it and use `moderate restore-post REVIEW_UUID REVIEW_REVISION`. Routine imports preserve pending, hidden, and owner-maintained listings. An authorized operator can explicitly change publication state with the moderation commands. After removal or account deletion, the API denies access to the removed media immediately. The cleanup job removes unreferenced objects older than an hour and clears expired sessions and request counters. Report evidence expires after 90 days and the audit trail after 365 days. Account deletion removes reply evidence keyed to that author. Apply your storage retention policy to backups and bucket soft deletion.

Run cleanup manually with `gcloud run jobs execute goodfork-cleanup --project "$PROJECT" --region "$REGION" --wait`. To schedule it, grant a Cloud Scheduler service account the Cloud Run Invoker role on that job. Then create an HTTP scheduler target for the job's authenticated run endpoint:

```sh
gcloud scheduler jobs create http goodfork-cleanup --project "$PROJECT" --location "$REGION" \
  --schedule '0 4 * * *' --time-zone 'Etc/UTC' --http-method POST \
  --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/goodfork-cleanup:run" \
  --oauth-service-account-email "goodfork-scheduler@$PROJECT.iam.gserviceaccount.com"
```

[Schedule Cloud Run jobs](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule)

## Optional dining and owner assistance

Goodfork provides local suggestions when model settings are empty. For an optional provider, set `AI_DINING_URL` or `AI_REPLY_URL` to a trusted HTTPS JSON gateway and set the matching `_MODEL` identifier. Bind the corresponding `_TOKEN` to a Secret Manager secret when the gateway requires a bearer credential. Keep Google Cloud secret access scoped to the API identity. The API makes one request for an opted-in assist, with a two-second deadline, an 8 KiB response limit, and a cooldown after upstream failures.

The gateway receives the operation, model identifier, and these exact feature-specific inputs. It returns the JSON object shown on the right. The categories are bounded enums selected from Goodfork's locally derived signals. For dining, the gateway chooses among supplied cuisine and dietary labels, or an empty string when that category has no candidates.

| Operation | Example input | Example response |
| --- | --- | --- |
| `dining` | `{"cuisines":["Japanese"],"diets":["Vegetarian"],"priceTier":2}` | `{"cuisine":"Japanese","diet":"Vegetarian"}` |
| `owner_reply` | `{"topics":["food","wait"],"sentiment":"positive","tone":"warm"}` | `{"topic":"food","opening":"appreciate","close":"welcome"}` |

Send the input under the `input` key with string keys `operation` and `model` at the top level. Respond with status 200 and `Content-Type: application/json`. Reply topics are `wait`, `service`, `food`, `value`, `room`, and `visit`. Opening is `thanks` or `appreciate`. Closing is `none`, or `welcome` for a positive review. Goodfork constructs the final text and stays responsible for evidence, filtering and publishing. Raw dining requests, reviews, account data, and precise location stay within Goodfork. Confirm your chosen gateway's logging, retention, and training terms before enabling an external provider.

Configure shared quotas with `GOODFORK_LIMIT_SIGNUP`, `GOODFORK_LIMIT_LOGIN`, `GOODFORK_LIMIT_VERIFY`, `GOODFORK_LIMIT_RECOVER`, `GOODFORK_LIMIT_GOOGLE_START`, `GOODFORK_LIMIT_GOOGLE_FINISH`, `GOODFORK_LIMIT_AI_LOCAL`, and `GOODFORK_LIMIT_AI_REMOTE` per minute. `GOODFORK_LIMIT_MAIL` applies per hour. Each valid deployment setting is a positive integer. Service-wide and per-identity quotas do not depend on forwarded IP headers.

## Review media and device release checks

The connected composer normalizes photos to JPEG. The API accepts JPEG and PNG photos within 12 megapixels and re-encodes them. New clips use H.264 video with optional AAC audio in MP4 or MOV, at most 30 seconds and 16 MiB. The service validates container structure, clears common metadata boxes, and checks an authorized object can open before starting a range response. Prior objects retain their existing read paths. Before opening public upload, verify device-produced clips, metadata normalization, captions, and the manual review and removal process against the intended release environment.

JPEG normalization applies EXIF orientation before removing metadata. Each instance defaults to one simultaneous upload normalization. `GOODFORK_UPLOAD_CONCURRENCY` accepts 1–4. Profile peak memory against the chosen Cloud Run allocation before increasing it. JSON/auth/database work has a ten-second request context. Uploads use 55 seconds and media reads 60 seconds. Shutdown cancels request contexts.

Structured hours require an explicit timezone, seven ordered daily period lists, and at most 60 date exceptions. Overnight service can extend into the next day. A date exception overrides that entire local date. Open-now directory pages carry a server as-of instant valid for 15 minutes. Refresh results after expiry. Legacy hours remain readable and carry an unknown availability state until structured hours are supplied.
