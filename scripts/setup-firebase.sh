#!/usr/bin/env bash
#
# One-time Firebase setup for Pegs and Jokers remote multiplayer.
#
# The coding agent that wrote this CANNOT run it — it has no Google credentials
# and must not be given any. You run it, once, on a machine where you have
# already done `gcloud auth login`. It is idempotent and re-runnable: every step
# tolerates "already exists", so if it fails partway you can just run it again.
#
# What it does (plan §2.6):
#   1. Creates a Google Cloud project and adds Firebase to it.
#   2. Enables the Firestore and Identity Toolkit APIs.
#   3. Creates a Firestore database in Native mode in a US multi-region (nam5),
#      which is in the always-free tier.
#   4. Enables Anonymous authentication (no console click — a config PATCH).
#   5. Creates a Web app and prints the four VITE_FIREBASE_* values for .env.
#   6. Deploys the security rules and the composite index.
#
# The commands below were verified against gcloud/firebase CLI current as of
# 2026-08. Flags drift between CLI versions; if one is rejected, run the failing
# command with --help and adjust. The two steps most likely to need a hand are
# called out inline: enabling Anonymous auth on a brand-new project, and reading
# the web app config.
#
# Usage:
#   ./scripts/setup-firebase.sh <project-id>
# or set PROJECT_ID in the environment. A project id is 6–30 lowercase letters,
# digits and hyphens, globally unique, e.g. "pnj-<yourname>-1234".

set -euo pipefail

PROJECT_ID="${1:-${PROJECT_ID:-}}"
REGION="${FIRESTORE_LOCATION:-nam5}"

# --- Preconditions ----------------------------------------------------------

fail() { echo "ERROR: $*" >&2; exit 1; }

command -v gcloud >/dev/null 2>&1 || fail \
  "gcloud not found. Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install"
command -v firebase >/dev/null 2>&1 || fail \
  "firebase not found. Install the Firebase CLI: npm install -g firebase-tools  (or https://firebase.google.com/docs/cli)"

[ -n "$PROJECT_ID" ] || fail "No project id. Usage: ./scripts/setup-firebase.sh <project-id>"

# Confirm gcloud has an authenticated account; the identity-toolkit PATCH below
# needs a real access token.
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  fail "gcloud is not authenticated. Run: gcloud auth login"
fi

echo "==> Using project: $PROJECT_ID   Firestore location: $REGION"

# A tiny helper: run a command, but don't abort the script if it fails because
# the resource already exists. Re-runnability depends on this.
run_ok_if_exists() {
  local why="$1"; shift
  echo "--> $*"
  if ! "$@"; then
    echo "    (continuing: $why)"
  fi
}

# --- 1. Project + Firebase --------------------------------------------------

run_ok_if_exists "project may already exist" \
  gcloud projects create "$PROJECT_ID" --name="Pegs and Jokers"

run_ok_if_exists "Firebase may already be added" \
  firebase projects:addfirebase "$PROJECT_ID"

# --- 2. APIs ----------------------------------------------------------------

echo "==> Enabling APIs (Firestore, Identity Toolkit)"
gcloud services enable firestore.googleapis.com identitytoolkit.googleapis.com \
  --project "$PROJECT_ID"

# --- 3. Firestore, Native mode, US multi-region (always-free tier) ----------

# --type=firestore-native and --location=nam5 verified current. The database id
# defaults to "(default)", which is the one the client SDK uses.
run_ok_if_exists "Firestore database may already exist" \
  gcloud firestore databases create \
    --location="$REGION" \
    --type=firestore-native \
    --project "$PROJECT_ID"

# --- 4. Anonymous authentication --------------------------------------------
#
# Enabling a sign-in provider is a config PATCH on the Identity Toolkit admin
# API — no console click required, in principle. The `x-goog-user-project`
# header is required: without it, a plain `gcloud auth print-access-token`
# bearer token is rejected with a 403 SERVICE_DISABLED ("no quota project set"),
# which looks nothing like the CONFIGURATION_NOT_FOUND case below and will
# silently masquerade as success if you only grep for that string. Learned the
# hard way — don't drop this header.
#
# Real caveat, confirmed against a live project: on a brand-new project whose
# Auth config has never been initialised, this returns CONFIGURATION_NOT_FOUND.
# There is no API-only fix — `identitytoolkit.googleapis.com/v2/.../identityPlatform:initializeAuth`
# looks like the answer but is the PAID Identity Platform upgrade and demands
# billing; it is not what a free anonymous-auth project needs. The actual fix is
# a one-time console visit: Build > Authentication > Get started. That
# provisions the free config with no billing involved. This script detects the
# failure and tells you to do that, then re-run.
echo "==> Enabling Anonymous auth"
ACCESS_TOKEN="$(gcloud auth print-access-token)"
HTTP_BODY="$(curl -sS -X PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/$PROJECT_ID/config?updateMask=signIn.anonymous.enabled" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "x-goog-user-project: $PROJECT_ID" \
  -H "Content-Type: application/json" \
  -d '{"signIn":{"anonymous":{"enabled":true}}}')" || true
if echo "$HTTP_BODY" | grep -q 'CONFIGURATION_NOT_FOUND'; then
  echo "    Auth config not initialised yet. Open the Firebase console once:"
  echo "      https://console.firebase.google.com/project/$PROJECT_ID/authentication"
  echo "    click 'Get started', then re-run this script."
  fail "Anonymous auth not enabled (see message above)."
fi
if ! echo "$HTTP_BODY" | grep -q '"enabled": *true'; then
  echo "    Unexpected response from the anonymous-auth PATCH:"
  echo "$HTTP_BODY" | sed 's/^/      /'
  fail "Anonymous auth not confirmed enabled — see response above."
fi
echo "    Anonymous auth enabled (confirmed)."

# --- 5. Web app + the four config values ------------------------------------

echo "==> Ensuring a Web app exists"
# Reuse an existing web app if there is one, so re-runs don't pile up apps.
APP_ID="$(firebase apps:list WEB --project "$PROJECT_ID" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const a=(r.result||[]).find(x=>x.platform==="WEB");process.stdout.write(a?a.appId:"")}catch{process.stdout.write("")}})' || true)"

if [ -z "$APP_ID" ]; then
  firebase apps:create WEB "pnj-web" --project "$PROJECT_ID"
  APP_ID="$(firebase apps:list WEB --project "$PROJECT_ID" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const a=(r.result||[]).find(x=>x.platform==="WEB");process.stdout.write(a?a.appId:"")}catch{process.stdout.write("")}})' || true)"
fi
[ -n "$APP_ID" ] || fail "Could not determine the Web app id. Run: firebase apps:list WEB --project $PROJECT_ID"

echo "==> Reading Web app config"
SDK_JSON="$(firebase apps:sdkconfig WEB "$APP_ID" --project "$PROJECT_ID" --json 2>/dev/null || true)"

# Extract the four values we need. `firebase apps:sdkconfig --json` wraps the
# config under result.sdkConfig; fall back gracefully if the shape differs.
read_cfg() {
  echo "$SDK_JSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let cfg={};
      try{const r=JSON.parse(s); cfg=(r.result&&r.result.sdkConfig)||r.sdkConfig||r.result||{};}catch{}
      process.stdout.write(String(cfg["'"$1"'"]||""));
    });'
}

API_KEY="$(read_cfg apiKey)"
AUTH_DOMAIN="$(read_cfg authDomain)"
PROJECT_ID_OUT="$(read_cfg projectId)"
APP_ID_OUT="$(read_cfg appId)"

# --- 6. Rules and indexes ---------------------------------------------------

echo "==> Deploying Firestore rules and indexes"
firebase deploy --only firestore:rules,firestore:indexes --project "$PROJECT_ID"

# --- Done -------------------------------------------------------------------

cat <<EOF

============================================================================
  Firebase is ready. Paste these into your .env (copy from .env.example),
  and add them to the GitHub repo as Actions *variables* (Settings >
  Secrets and variables > Actions > Variables) so the Pages build bakes them
  in. They are public by design — not secrets.
============================================================================

VITE_FIREBASE_API_KEY=${API_KEY:-<see: firebase apps:sdkconfig WEB $APP_ID --project $PROJECT_ID>}
VITE_FIREBASE_AUTH_DOMAIN=${AUTH_DOMAIN:-${PROJECT_ID}.firebaseapp.com}
VITE_FIREBASE_PROJECT_ID=${PROJECT_ID_OUT:-$PROJECT_ID}
VITE_FIREBASE_APP_ID=${APP_ID_OUT:-$APP_ID}

To redeploy the rules later after editing firestore/firestore.rules:
    npm run rules:deploy -- --project $PROJECT_ID
EOF
