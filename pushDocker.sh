#!/bin/bash

# Build + push dell'immagine su GitHub Container Registry (GHCR).
#
# ⚠️  NON scrivere MAI il token qui dentro: questo file è nel repo PUBBLICO.
#     Il login è interattivo (username + PAT con scope `write:packages`),
#     oppure esporta la variabile GHCR_TOKEN prima di lanciare lo script.

# ─── CONFIGURAZIONE ───────────────────────────────────────────────────────────
IMAGE="ghcr.io/v3zz0/budget-api"
VERSION="1.0"
# ──────────────────────────────────────────────────────────────────────────────

set -e

MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
FULL_IMAGE="${IMAGE}:${VERSION}"

echo "==> Immagine: $FULL_IMAGE"

if ! sudo docker info > /dev/null 2>&1; then
    echo "Errore: Docker non raggiungibile."
    exit 1
fi

# Login a GHCR
if [ -n "$GHCR_TOKEN" ]; then
    echo "==> Login a ghcr.io (da GHCR_TOKEN)..."
    echo "$GHCR_TOKEN" | sudo docker login ghcr.io -u v3zz0 --password-stdin
else
    echo "==> Login a ghcr.io (username: v3zz0, password: il tuo PAT con scope write:packages)"
    sudo docker login ghcr.io -u v3zz0
fi

# Build
echo ""
echo "==> Build: $FULL_IMAGE"
sudo docker build -t "$FULL_IMAGE" .
sudo docker tag "$FULL_IMAGE" "${IMAGE}:latest"

# Push
echo ""
echo "==> Push: $FULL_IMAGE"
sudo docker push "$FULL_IMAGE"
sudo docker push "${IMAGE}:latest"

# Incrementa minor e aggiorna lo script
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="${MAJOR}.${NEW_MINOR}"
sed -i "s/^VERSION=\"${VERSION}\"/VERSION=\"${NEW_VERSION}\"/" "$0"

echo ""
echo "==> Fatto! Immagine: ${FULL_IMAGE} (e :latest). Prossima versione: ${NEW_VERSION}"
echo "    Sul server: aggiorna 'image: ${FULL_IMAGE}' nel compose, poi 'docker compose pull && docker compose up -d'"
