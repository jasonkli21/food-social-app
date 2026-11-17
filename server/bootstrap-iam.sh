#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT:?Set PROJECT to your Google Cloud project ID}"
: "${BUCKET:?Set BUCKET to your private Goodfork bucket name}"

ensure_service_account() {
  local name="$1"
  local address="$name@$PROJECT.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$address" --project "$PROJECT" --quiet >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --project "$PROJECT" --quiet
  fi
}

grant_secret() {
  local secret="$1"
  local name="$2"
  gcloud secrets add-iam-policy-binding "$secret" --project "$PROJECT" --quiet \
    --member "serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" \
    --role roles/secretmanager.secretAccessor
}

grant_bucket() {
  local name="$1"
  local role="$2"
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --project "$PROJECT" --quiet \
    --member "serviceAccount:$name@$PROJECT.iam.gserviceaccount.com" --role "$role"
}

for name in goodfork-api goodfork-migrate goodfork-cleanup; do
  ensure_service_account "$name"
done

grant_secret goodfork-neon-migrate goodfork-migrate
grant_secret goodfork-neon-runtime goodfork-api
grant_secret goodfork-neon-cleanup goodfork-cleanup
grant_secret goodfork-blocked-terms goodfork-api
grant_secret goodfork-smtp-password goodfork-api
if [[ "${ENABLE_GOOGLE_LOGIN:-0}" == "1" ]]; then
  grant_secret goodfork-google-client-secret goodfork-api
fi

grant_bucket goodfork-api roles/storage.objectCreator
grant_bucket goodfork-api roles/storage.objectViewer
grant_bucket goodfork-cleanup roles/storage.objectUser
