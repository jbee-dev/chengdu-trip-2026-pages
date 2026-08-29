const OWNER = "jbee-dev";
const ALLOWED_ORIGIN = "https://jbee-dev.github.io";
const ALLOWED_FILES: Readonly<Record<string, readonly string[]>> = {
  "chengdu-trip-2026-pages": ["index.html"],
  "bali-trip-2026-pages": ["index.html", "plan.html"],
};
const API_VERSION = "2026-03-10";
// Keep edits deliberately small so the Worker stays comfortably inside the
// Free plan's 10 ms CPU budget. Photos live as GitHub Pages static assets.
const MAX_HTML_BYTES = 512 * 1024;
const MAX_SYNC_BYTES = 2.5 * 1024 * 1024;
const MAX_SYNC_FILES = 20;

type Session = { login: string; token: string; exp: number };
type OAuthState = { returnTo: string; nonce: string; exp: number };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "request_failed",
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") return corsPreflight(request);
      if (url.pathname === "/health" && request.method === "GET") {
        return json({ ok: true, service: "jbee-trip-editor" }, 200, request);
      }
      if (url.pathname === "/auth/start" && request.method === "GET") {
        return startOAuth(url, env);
      }
      if (url.pathname === "/auth/callback" && request.method === "GET") {
        return finishOAuth(url, env, requestId);
      }
      if (url.pathname === "/api/file" && request.method === "GET") {
        const session = await requireSession(request, env);
        return getFile(url, session, request);
      }
      if (url.pathname === "/api/file" && request.method === "PUT") {
        const session = await requireSession(request, env);
        return updateFile(request, session);
      }
      if (url.pathname === "/api/sync" && request.method === "POST") {
        const session = await requireSession(request, env);
        return syncFiles(request, session);
      }
      throw new HttpError(404, "요청한 주소를 찾을 수 없습니다.", "not_found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
      console.error(JSON.stringify({ event: "request_error", requestId, path: url.pathname, status, code, message }));
      return json({ ok: false, error: code, message, requestId }, status, request);
    }
  },
} satisfies ExportedHandler<Env>;

async function startOAuth(url: URL, env: Env): Promise<Response> {
  if (env.GITHUB_CLIENT_ID.startsWith("pending-")) {
    throw new HttpError(503, "GitHub 로그인이 아직 설정되지 않았습니다.", "oauth_not_ready");
  }
  const requestedReturn = url.searchParams.get("return") ?? env.EDITOR_URL;
  const returnTo = safeEditorUrl(requestedReturn, env.EDITOR_URL);
  const statePayload: OAuthState = {
    returnTo,
    nonce: crypto.randomUUID(),
    exp: Date.now() + 10 * 60 * 1000,
  };
  const state = await signState(statePayload, env.SESSION_SECRET);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("scope", "public_repo");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "false");
  return Response.redirect(authorize.toString(), 302);
}

async function finishOAuth(url: URL, env: Env, requestId: string): Promise<Response> {
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  if (!code || !rawState) throw new HttpError(400, "로그인 응답이 올바르지 않습니다.", "invalid_callback");
  const state = await verifyState(rawState, env.SESSION_SECRET);
  if (state.exp < Date.now()) throw new HttpError(400, "로그인 요청이 만료되었습니다.", "expired_state");

  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "jbee-trip-editor" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = await tokenResponse.json<{ access_token?: string; error?: string }>();
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new HttpError(401, `GitHub 로그인을 완료하지 못했습니다: ${tokenData.error ?? tokenResponse.status}`, "token_exchange_failed");
  }

  const user = await github<{ login: string }>("/user", tokenData.access_token);
  if (user.login.toLowerCase() !== OWNER) {
    console.warn(JSON.stringify({ event: "unauthorized_login", requestId, login: user.login }));
    throw new HttpError(403, "이 편집기는 jbee-dev 계정만 사용할 수 있습니다.", "wrong_account");
  }

  const session = await encryptSession(
    { login: user.login, token: tokenData.access_token, exp: Date.now() + 8 * 60 * 60 * 1000 },
    env.SESSION_SECRET,
  );
  const redirect = new URL(state.returnTo);
  redirect.hash = new URLSearchParams({ session }).toString();
  console.log(JSON.stringify({ event: "oauth_success", requestId, login: user.login }));
  return Response.redirect(redirect.toString(), 302);
}

async function getFile(url: URL, session: Session, request: Request): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const branch = normalizeBranch(url.searchParams.get("branch"));
  assertAllowed(repo, path);

  const head = await getHead(repo, branch, session.token);
  const commit = await github<{ tree: { sha: string } }>(`/repos/${OWNER}/${repo}/git/commits/${head}`, session.token);
  const tree = await github<{ tree: Array<{ path: string; type: string; sha: string }> }>(
    `/repos/${OWNER}/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
    session.token,
  );
  const entry = tree.tree.find((item) => item.path === path && item.type === "blob");
  if (!entry) throw new HttpError(404, "편집할 파일을 찾지 못했습니다.", "file_not_found");
  const blobResponse = await githubResponse(`/repos/${OWNER}/${repo}/git/blobs/${entry.sha}`, session.token, {
    Accept: "application/vnd.github.raw+json",
  });
  const headers = corsHeaders(request);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Commit-Sha", head);
  headers.set("X-Blob-Sha", entry.sha);
  headers.set("X-Editor-Login", session.login);
  return new Response(blobResponse.body, { status: 200, headers });
}

async function updateFile(request: Request, session: Session): Promise<Response> {
  const body = await parseJson<{ repo?: string; path?: string; branch?: string; baseCommit?: string; html?: string; message?: string }>(request);
  const repo = body.repo ?? "";
  const path = body.path ?? "";
  const branch = normalizeBranch(body.branch);
  const html = body.html ?? "";
  const baseCommit = body.baseCommit ?? "";
  assertAllowed(repo, path);
  if (!/^[0-9a-f]{40}$/i.test(baseCommit)) throw new HttpError(400, "기준 버전 정보가 올바르지 않습니다.", "invalid_base_commit");
  if (!html.trim().toLowerCase().startsWith("<!doctype html")) throw new HttpError(400, "완전한 HTML5 문서만 게시할 수 있습니다.", "invalid_html");
  if (new TextEncoder().encode(html).byteLength > MAX_HTML_BYTES) throw new HttpError(413, "페이지가 허용 크기를 넘었습니다.", "file_too_large");

  const head = await getHead(repo, branch, session.token);
  if (head !== baseCommit) throw new HttpError(409, "다른 곳에서 페이지가 먼저 바뀌었습니다. 다시 불러온 뒤 수정해 주세요.", "version_conflict");
  const currentCommit = await github<{ tree: { sha: string } }>(`/repos/${OWNER}/${repo}/git/commits/${head}`, session.token);
  const blob = await github<{ sha: string }>(`/repos/${OWNER}/${repo}/git/blobs`, session.token, {
    method: "POST",
    body: JSON.stringify({ content: html, encoding: "utf-8" }),
  });
  const tree = await github<{ sha: string }>(`/repos/${OWNER}/${repo}/git/trees`, session.token, {
    method: "POST",
    body: JSON.stringify({ base_tree: currentCommit.tree.sha, tree: [{ path, mode: "100644", type: "blob", sha: blob.sha }] }),
  });
  const message = sanitizeMessage(body.message) || `웹 편집기에서 ${path} 업데이트`;
  const commit = await github<{ sha: string; html_url: string }>(`/repos/${OWNER}/${repo}/git/commits`, session.token, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [head] }),
  });
  await github(`/repos/${OWNER}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, session.token, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  console.log(JSON.stringify({ event: "page_published", login: session.login, repo, path, commit: commit.sha }));
  return json({ ok: true, commit: commit.sha, url: commit.html_url }, 200, request);
}

async function syncFiles(request: Request, session: Session): Promise<Response> {
  type SyncFile = { path?: string; content?: string };
  const body = await parseJson<{ repo?: string; branch?: string; files?: SyncFile[]; message?: string }>(request, MAX_SYNC_BYTES);
  const repo = body.repo ?? "";
  const branch = normalizeBranch(body.branch);
  const files = body.files ?? [];
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FILES, repo)) {
    throw new HttpError(403, "허용되지 않은 저장소입니다.", "repo_not_allowed");
  }
  if (!files.length || files.length > MAX_SYNC_FILES) {
    throw new HttpError(400, `파일은 한 번에 1-${MAX_SYNC_FILES}개까지 업로드할 수 있습니다.`, "invalid_file_count");
  }
  const seen = new Set<string>();
  for (const file of files) {
    const path = file.path ?? "";
    const content = file.content ?? "";
    if (!isSyncPathAllowed(repo, path) || seen.has(path)) {
      throw new HttpError(403, "허용되지 않거나 중복된 파일 경로입니다.", "file_not_allowed");
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
      throw new HttpError(400, "파일 내용이 올바른 base64 형식이 아닙니다.", "invalid_content");
    }
    seen.add(path);
  }

  const head = await getHead(repo, branch, session.token);
  const currentCommit = await github<{ tree: { sha: string } }>(`/repos/${OWNER}/${repo}/git/commits/${head}`, session.token);
  const treeEntries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of files) {
    const blob = await github<{ sha: string }>(`/repos/${OWNER}/${repo}/git/blobs`, session.token, {
      method: "POST",
      body: JSON.stringify({ content: file.content, encoding: "base64" }),
    });
    treeEntries.push({ path: file.path!, mode: "100644", type: "blob", sha: blob.sha });
  }
  const tree = await github<{ sha: string }>(`/repos/${OWNER}/${repo}/git/trees`, session.token, {
    method: "POST",
    body: JSON.stringify({ base_tree: currentCommit.tree.sha, tree: treeEntries }),
  });
  const message = sanitizeMessage(body.message) || `Sync ${files.length} trip page files`;
  const commit = await github<{ sha: string; html_url: string }>(`/repos/${OWNER}/${repo}/git/commits`, session.token, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [head] }),
  });
  await github(`/repos/${OWNER}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, session.token, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  console.log(JSON.stringify({ event: "repo_synced", login: session.login, repo, files: files.length, commit: commit.sha }));
  return json({ ok: true, commit: commit.sha, url: commit.html_url, files: files.length }, 200, request);
}

async function requireSession(request: Request, env: Env): Promise<Session> {
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "GitHub 로그인이 필요합니다.", "login_required");
  const session = await decryptSession(auth.slice(7), env.SESSION_SECRET);
  if (session.exp < Date.now() || session.login.toLowerCase() !== OWNER) {
    throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해 주세요.", "session_expired");
  }
  return session;
}

function assertAllowed(repo: string, path: string): void {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_FILES, repo) || !ALLOWED_FILES[repo].includes(path)) {
    throw new HttpError(403, "허용되지 않은 페이지입니다.", "file_not_allowed");
  }
}

function isSyncPathAllowed(repo: string, path: string): boolean {
  if (/^assets\/trip-[0-9a-f]{16}\.(?:jpg|png)$/.test(path)) return true;
  if (repo === "chengdu-trip-2026-pages") {
    return [
      "index.html",
      "admin.html",
      "editor-worker/.gitignore",
      "editor-worker/README.md",
      "editor-worker/package.json",
      "editor-worker/pnpm-lock.yaml",
      "editor-worker/pnpm-workspace.yaml",
      "editor-worker/src/index.ts",
      "editor-worker/tsconfig.json",
      "editor-worker/worker-configuration.d.ts",
      "editor-worker/wrangler.jsonc",
    ].includes(path);
  }
  return repo === "bali-trip-2026-pages" && ["index.html", "plan.html", "edit.html"].includes(path);
}

function normalizeBranch(branch: string | null | undefined): string {
  const value = branch || "main";
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(value) || value.includes("..")) throw new HttpError(400, "브랜치 이름이 올바르지 않습니다.", "invalid_branch");
  return value;
}

function sanitizeMessage(message?: string): string {
  return (message ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
}

async function getHead(repo: string, branch: string, token: string): Promise<string> {
  const ref = await github<{ object: { sha: string } }>(`/repos/${OWNER}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  return ref.object.sha;
}

async function github<T = unknown>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await githubResponse(path, token, init.headers as Record<string, string> | undefined, init);
  if (response.status === 204) return undefined as T;
  return response.json<T>();
}

async function githubResponse(
  path: string,
  token: string,
  extraHeaders: Record<string, string> = {},
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "jbee-trip-editor",
      "X-GitHub-Api-Version": API_VERSION,
      ...extraHeaders,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const status = response.status === 409 || response.status === 422 ? 409 : response.status;
    throw new HttpError(status, `GitHub 처리 중 오류가 발생했습니다 (${response.status}): ${detail}`, "github_error");
  }
  return response;
}

async function parseJson<T>(request: Request, maxBytes = MAX_HTML_BYTES * 1.5): Promise<T> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > maxBytes) throw new HttpError(413, "요청이 너무 큽니다.", "request_too_large");
  try {
    return await request.json<T>();
  } catch {
    throw new HttpError(400, "요청 내용을 읽을 수 없습니다.", "invalid_json");
  }
}

function safeEditorUrl(candidate: string, fallback: string): string {
  try {
    const value = new URL(candidate);
    const allowed = new URL(fallback);
    if (value.origin === allowed.origin && value.pathname === allowed.pathname) return value.toString();
  } catch {
    // Fall back to the configured editor URL.
  }
  return fallback;
}

async function signState(state: OAuthState, secret: string): Promise<string> {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(state)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyState(value: string, secret: string): Promise<OAuthState> {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) throw new HttpError(400, "로그인 상태값이 올바르지 않습니다.", "invalid_state");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const signatureBytes = base64UrlDecode(signature);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer,
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new HttpError(400, "로그인 상태값을 확인할 수 없습니다.", "invalid_state");
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as OAuthState;
  } catch {
    throw new HttpError(400, "로그인 상태값을 읽을 수 없습니다.", "invalid_state");
  }
}

async function encryptSession(session: Session, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(session)));
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);
  return base64UrlEncode(result);
}

async function decryptSession(value: string, secret: string): Promise<Session> {
  try {
    const packed = base64UrlDecode(value);
    if (packed.length < 29) throw new Error("short session");
    const iv = packed.slice(0, 12);
    const encrypted = packed.slice(12);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await sessionKey(secret), encrypted);
    return JSON.parse(new TextDecoder().decode(decrypted)) as Session;
  } catch {
    throw new HttpError(401, "로그인 정보가 올바르지 않습니다.", "invalid_session");
  }
}

async function sessionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function corsPreflight(request: Request): Response {
  const origin = request.headers.get("Origin");
  if (origin !== ALLOWED_ORIGIN) throw new HttpError(403, "허용되지 않은 웹사이트입니다.", "origin_not_allowed");
  const headers = corsHeaders(request);
  headers.set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(null, { status: 204, headers });
}

function corsHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: "Origin" });
  if (request.headers.get("Origin") === ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("Access-Control-Expose-Headers", "X-Commit-Sha, X-Blob-Sha, X-Editor-Login");
  }
  return headers;
}

function json(value: unknown, status: number, request: Request): Response {
  const headers = corsHeaders(request);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}
