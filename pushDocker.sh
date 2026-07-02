#!/bin/bash

# ─── CONFIGURAZIONE ───────────────────────────────────────────────────────────
IMAGE="registry.example.com/budgetapp/budget-api"
VERSION="6.3"
# ──────────────────────────────────────────────────────────────────────────────

set -e

# Estrai major e minor dalla versione
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)

FULL_IMAGE="${IMAGE}:${VERSION}"

echo "==> Immagine: $FULL_IMAGE"

# Controlla se già loggato
if ! sudo docker info > /dev/null 2>&1; then
    echo "Errore: Docker non raggiungibile."
    exit 1
fi

REGISTRY=$(echo "$IMAGE" | cut -d/ -f1)

if sudo docker login "$REGISTRY" 2>/dev/null | grep -q "Login Succeeded" || \
   sudo docker system info 2>/dev/null | grep -q "$REGISTRY"; then
    echo "==> Già loggato a $REGISTRY"
else
    echo "==> Login a $REGISTRY..."
    sudo docker login "$REGISTRY"
fi

# Build
echo ""
echo "==> Build: $FULL_IMAGE"
sudo docker build -t "$FULL_IMAGE" .

# Push
echo ""
echo "==> Push: $FULL_IMAGE"
sudo docker push "$FULL_IMAGE"

# Incrementa minor e aggiorna lo script
NEW_MINOR=$((MINOR + 1))
NEW_VERSION="${MAJOR}.${NEW_MINOR}"

sed -i "s/^VERSION=\"${VERSION}\"/VERSION=\"${NEW_VERSION}\"/" "$0"

echo ""
echo "==> Fatto! Prossima versione: ${NEW_VERSION}"
