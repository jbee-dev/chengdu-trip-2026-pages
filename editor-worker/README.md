# 여행 페이지 웹 편집 서비스

`admin.html`에서 청두와 발리 GitHub Pages 문서를 직접 수정하고 게시하기 위한 Cloudflare Worker입니다.

## 보호 범위

- GitHub 계정 `jbee-dev`만 로그인할 수 있습니다.
- `chengdu-trip-2026-pages/index.html`, `bali-trip-2026-pages/index.html`, `bali-trip-2026-pages/plan.html`만 읽고 쓸 수 있습니다.
- GitHub 액세스 토큰은 브라우저에 그대로 전달하지 않고, Worker가 암호화한 8시간짜리 세션만 브라우저 탭에 보관합니다.
- 게시 직전에 현재 Git 커밋을 다시 비교해 다른 수정 내용을 덮어쓰지 않습니다.
- GitHub 클라이언트 비밀값과 세션 암호키는 Cloudflare Secret으로만 저장합니다.

## Free Tier 보호

- Workers Free 플랜에서만 배포하고 유료 플랜으로 전환하지 않습니다.
- KV, D1, R2, Durable Objects, Queues, Workflows, Workers AI, Cron Trigger를 사용하지 않습니다.
- 페이지 편집을 사람이 직접 할 때만 Worker가 호출됩니다. 사진과 공개 페이지 자체는 GitHub Pages가 제공합니다.
- HTML 본문을 512 KiB 이하로 제한합니다. 큰 사진은 각 저장소의 `assets/` 정적 파일로 분리합니다.
- 요청 로그는 1%만 표본 수집하고 호출 로그와 분산 추적은 끕니다.
- Free 한도를 넘으면 편집 기능이 오류로 멈추도록 두며, 유료 초과 사용으로 전환하지 않습니다.

## 배포 준비

1. `pnpm install`
2. `pnpm run types`
3. `pnpm run check`
4. `pnpm run build`
5. Cloudflare에 `GITHUB_CLIENT_SECRET`, `SESSION_SECRET`을 Secret으로 등록합니다.
6. GitHub OAuth App의 callback URL은 배포된 Worker의 `/auth/callback`로 지정합니다.
7. `wrangler.jsonc`의 `GITHUB_CLIENT_ID`와 `admin.html`의 Worker 주소를 실제 값으로 바꿉니다.
8. `wrangler deploy`로 게시합니다.

OAuth App에는 공개 저장소만 수정하는 `public_repo` 범위를 요청합니다. Worker 소스와 이 설명서는 저장소에 남기되, 실제 비밀값은 절대 커밋하지 않습니다.
