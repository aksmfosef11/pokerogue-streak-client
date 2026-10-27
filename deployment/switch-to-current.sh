#!/bin/bash
# Switch an existing Mac mini ZIP installation to the current-version stack.
set -euo pipefail
ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
cd "$ROOT_DIR"
[ -f .env ] && [ -f compose.sh ] || {
  echo '기존 pokerogue-macmini 폴더의 .env와 compose.sh를 찾지 못했습니다.' >&2
  exit 1
}
if grep -Fq 'client/deployment/compose.pvp.yml' compose.sh; then
  OLD_STACK=1
elif grep -Fq 'client/deployment/compose.current.yml' compose.sh; then
  OLD_STACK=0
else
  echo 'compose.sh에 예상한 배포 설정이 없습니다. 직접 수정한 설정을 확인하세요.' >&2
  exit 1
fi

docker compose --project-name pokerogue-macmini --env-file "$ROOT_DIR/.env" \
  -f "$ROOT_DIR/client/deployment/compose.current.yml" config --quiet
echo '1.12.2.0 이미지를 빌드합니다. 기존 서버는 빌드 중 계속 실행됩니다.'
docker compose --project-name pokerogue-macmini --env-file "$ROOT_DIR/.env" \
  -f "$ROOT_DIR/client/deployment/compose.current.yml" --parallel 1 build

if [ "$OLD_STACK" -eq 1 ]; then
  echo '구버전 게임 및 검증 컨테이너를 정리합니다.'
  bash compose.sh stop audit audit-1-12-1-2 game-1-12-1-2 game-1-12-1-3
  bash compose.sh rm -f audit audit-1-12-1-2 game-1-12-1-2 game-1-12-1-3
  BACKUP="$(mktemp "$ROOT_DIR/.compose-before-current.XXXXXX")"
  cp -p compose.sh "$BACKUP"
  TEMP="$(mktemp "$ROOT_DIR/.compose-current.XXXXXX")"
  sed 's@client/deployment/compose.pvp.yml@client/deployment/compose.current.yml@g' compose.sh > "$TEMP"
  chmod 755 "$TEMP"
  mv "$TEMP" compose.sh
  echo "기존 실행 스크립트 백업: $BACKUP"
fi

bash compose.sh up -d --wait --wait-timeout 300
echo '1.12.2.0 서버가 시작되었습니다. 기존 데이터 볼륨은 유지됩니다.'
