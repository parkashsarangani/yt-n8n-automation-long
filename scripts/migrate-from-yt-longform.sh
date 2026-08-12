#!/usr/bin/env bash
#
# One-time migration: docker compose project "yt-longform" -> "amos".
#
# Dockerizing AMOS renamed the compose project. Volumes are project-prefixed, so
# without this the new stack starts with empty volumes and the old containers
# keep holding port 4001.
#
# This is NON-DESTRUCTIVE: old volumes are copied, never deleted. Verify the new
# stack, then remove them yourself with
#   docker volume rm yt-longform_long_n8n_data yt-longform_long_data yt-longform_long_outputs
#
# Safe to re-run: volumes that already hold data are skipped.
set -euo pipefail

# Overridable so the migration can be rehearsed against throwaway names.
OLD=${OLD_PROJECT:-yt-longform}
NEW=${NEW_PROJECT:-amos}
VOLUMES=(long_n8n_data long_data long_outputs)

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if ! docker volume ls --format '{{.Name}}' | grep -qx "${OLD}_long_n8n_data"; then
  say "Nothing to migrate — no ${OLD}_* volumes found."
  echo "This server has probably never run the pre-AMOS stack. Just start normally:"
  echo "  docker compose up -d --build"
  exit 0
fi

say "1/3  Stopping the old '${OLD}' stack (it holds ports 4001/5679)"
# --project-name alone is enough; the old compose file no longer exists in the
# checkout, so drive it off the running containers' labels instead.
old_containers=$(docker ps -aq --filter "label=com.docker.compose.project=${OLD}")
if [ -n "$old_containers" ]; then
  # shellcheck disable=SC2086
  docker stop $old_containers
  # shellcheck disable=SC2086
  docker rm $old_containers
  echo "   stopped and removed $(echo "$old_containers" | wc -l) container(s)"
else
  echo "   already stopped"
fi

say "2/3  Copying volume data ${OLD}_* -> ${NEW}_*"
for v in "${VOLUMES[@]}"; do
  src="${OLD}_${v}"
  dst="${NEW}_${v}"

  if ! docker volume ls --format '{{.Name}}' | grep -qx "$src"; then
    echo "   skip  $src (does not exist)"
    continue
  fi

  docker volume create "$dst" > /dev/null

  # Skip a destination that already has content, so re-running cannot clobber
  # data the new stack has already written.
  if [ -n "$(docker run --rm -v "$dst":/dst alpine:3 sh -c 'ls -A /dst 2>/dev/null')" ]; then
    echo "   skip  $dst (already has data)"
    echo "         if that data is junk from a failed deploy and you want the"
    echo "         old contents instead:  docker volume rm $dst  then re-run"
    continue
  fi

  docker run --rm -v "$src":/src:ro -v "$dst":/dst alpine:3 \
    sh -c 'cp -a /src/. /dst/ 2>/dev/null || true'
  echo "   copied $src -> $dst"
done

say "3/3  Done"
cat <<MSG
Start the new stack:
  docker compose up -d --build

The old ${OLD}_* volumes were left untouched. Remove them once you have
confirmed the new stack works:
  docker volume rm ${VOLUMES[*]/#/${OLD}_}
MSG
