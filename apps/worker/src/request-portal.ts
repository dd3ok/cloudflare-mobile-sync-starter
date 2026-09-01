import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { PublicError } from "./errors";
import {
  createRequestCases,
  ensureRequestPurgeLedgerApplied,
  type OpenCase,
  type RequestLocale,
} from "./request-cases";
import {
  createPortalGoogleChallenge,
  parseGoogleProof,
  type VerifyAdmin,
  type VerifyGoogleIdentity,
  type VerifyTurnstile,
  verifyAdmin,
  verifyGoogleIdentity,
  verifyTurnstile,
} from "./request-identity";
import {
  isRequestPortalOrigin,
  type RequestPortalConfig,
  requestPortalConfig,
  requestPortalDatabase,
  requestPortalEnabled,
} from "./request-portal-config";

const MAX_PORTAL_BODY_BYTES = 24 * 1_024;

const commonCaseFields = {
  locale: z.enum(["ko", "en"]),
  noticeVersion: z.string().min(1).max(32),
};

const anonymousCaseSchema = z.union([
  z
    .object({
      ...commonCaseFields,
      kind: z.literal("inquiry"),
      privacyAction: z.undefined().optional(),
      requestText: z.string().min(1),
      turnstileToken: z.string().min(1).max(2_048),
    })
    .strict(),
  z
    .object({
      ...commonCaseFields,
      kind: z.literal("privacy_request"),
      privacyAction: z.literal("identity_issue"),
      requestText: z.string().min(1),
      turnstileToken: z.string().min(1).max(2_048),
    })
    .strict(),
]);

const googleCaseSchema = z.union([
  z
    .object({
      ...commonCaseFields,
      kind: z.literal("account_deletion"),
      confirmed: z.literal(true),
      google: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...commonCaseFields,
      kind: z.literal("privacy_request"),
      privacyAction: z.enum(["access", "correction", "restriction", "withdrawal", "objection"]),
      requestText: z.string().optional(),
      google: z.unknown(),
    })
    .strict(),
]);

const viewSchema = z.object({ receipt: z.string().min(1).max(160) }).strict();
const resolveSchema = z
  .object({
    status: z.enum(["completed", "rejected"]),
    outcomeCode: z.string().min(1).max(64),
    responseText: z.string().min(1),
  })
  .strict();

export interface RequestPortalDependencies {
  verifyGoogleIdentity?: VerifyGoogleIdentity;
  verifyTurnstile?: VerifyTurnstile;
  verifyAdmin?: VerifyAdmin;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_PORTAL_BODY_BYTES) {
    throw new PublicError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_PORTAL_BODY_BYTES) {
    throw new PublicError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new PublicError(400, "VALIDATION_ERROR", "Request body must be valid JSON");
  }
}

interface ReadyPortal {
  config: RequestPortalConfig;
  databases: { DB: D1Database; REQUEST_DB: D1Database };
}

async function portalContext(request: Request, env: Env): Promise<ReadyPortal> {
  if (!requestPortalEnabled(env)) throw new PublicError(404, "NOT_FOUND", "Route not found");
  const config = requestPortalConfig(env);
  if (!isRequestPortalOrigin(request, config)) {
    throw new PublicError(404, "NOT_FOUND", "Route not found");
  }
  const databases = { DB: env.DB, REQUEST_DB: requestPortalDatabase(env) };
  try {
    await ensureRequestPurgeLedgerApplied(databases, config);
  } catch {
    throw new PublicError(
      503,
      "PROVIDER_UNAVAILABLE",
      "The request portal is in restore maintenance",
      true,
    );
  }
  return { config, databases };
}

function requireSameOrigin(request: Request, config: RequestPortalConfig): void {
  if (request.headers.get("origin") !== config.origin) {
    throw new PublicError(403, "FORBIDDEN", "Same-origin request required");
  }
}

async function limit(env: Env, key: string): Promise<void> {
  const result = await env.AUTH_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new PublicError(429, "RATE_LIMITED", "Too many request portal attempts", true);
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function portalHeaders(nonce: string): Record<string, string> {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}' https://accounts.google.com/gsi/client https://challenges.cloudflare.com`,
      `style-src 'nonce-${nonce}' https://accounts.google.com/gsi/style`,
      "connect-src 'self' https://accounts.google.com https://challenges.cloudflare.com",
      "frame-src https://accounts.google.com https://challenges.cloudflare.com",
      "img-src data:",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  };
}

function userPage(config: RequestPortalConfig, locale: RequestLocale): string {
  const ko = locale === "ko";
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const copy = ko
    ? {
        title: "요청·계정 삭제",
        intro: `${config.organizationName} 문의와 ${config.productName} 개인정보·계정 요청을 접수합니다. 이메일·전화번호·첨부파일은 입력하지 마세요.`,
        requestType: "요청 종류",
        text: "요청 내용",
        submit: "익명 요청 접수",
        google: "Google로 본인 확인",
        deleteConfirm: "서비스 계정과 서버 저장 데이터의 영구 삭제를 확인합니다.",
        receipt: "비밀 조회값",
        receiptWarning: "이 값은 다시 발급되지 않을 수 있습니다. 안전한 곳에 저장하세요.",
        view: "상태 조회",
        notice: `현재 고지 버전: ${config.noticeVersion}`,
      }
    : {
        title: "Requests and account deletion",
        intro: `Submit ${config.organizationName} inquiries and ${config.productName} privacy or account requests. Do not enter an email address, phone number, or attachment.`,
        requestType: "Request type",
        text: "Request details",
        submit: "Submit anonymous request",
        google: "Verify with Google",
        deleteConfirm: "I confirm permanent deletion of the service account and server-side data.",
        receipt: "Secret receipt",
        receiptWarning: "This value may not be recoverable. Store it securely.",
        view: "View status",
        notice: `Current notice version: ${config.noticeVersion}`,
      };
  const options: [string, string][] = ko
    ? [
        ["inquiry", "일반 문의"],
        ["access", "개인정보 열람"],
        ["correction", "개인정보 정정"],
        ["restriction", "처리정지"],
        ["withdrawal", "동의 철회"],
        ["objection", "이의제기"],
      ]
    : [
        ["inquiry", "General inquiry"],
        ["access", "Access personal data"],
        ["correction", "Correct personal data"],
        ["restriction", "Restrict processing"],
        ["withdrawal", "Withdraw consent"],
        ["objection", "Object to processing"],
      ];
  if (config.accountDeletionEnabled) {
    options.splice(1, 0, ["account_deletion", ko ? "계정 삭제" : "Delete account"]);
  }
  if (config.identityIssueEnabled) {
    options.push(["identity_issue", ko ? "Google 인증 문제 권리요청" : "Identity-access issue"]);
  }
  const runtimeConfig = safeJson({
    noticeVersion: config.noticeVersion,
    turnstileSiteKey: config.turnstileSiteKey,
    locale,
  });
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(copy.title)} · ${escapeHtml(config.organizationName)}</title>
<style nonce="${nonce}">
:root{font-family:system-ui,sans-serif;color:#171717;background:#f7f7f4}body{margin:0}.wrap{max-width:720px;margin:auto;padding:32px 20px 64px}main{background:white;border:1px solid #ddd;border-radius:16px;padding:24px}h1{font-size:1.8rem;margin-top:0}label{display:block;font-weight:650;margin:20px 0 8px}select,textarea,input,button{font:inherit}select,textarea,input[type=text]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #999;border-radius:8px}textarea{min-height:140px;resize:vertical}button{margin-top:16px;padding:11px 16px;border:0;border-radius:8px;background:#222;color:white;cursor:pointer}button[hidden],section[hidden],div[hidden]{display:none}.muted{color:#555;font-size:.94rem}.notice{padding:12px;background:#f1f1ec;border-radius:8px}.result{white-space:pre-wrap;overflow-wrap:anywhere;padding:14px;background:#eef6ee;border-radius:8px;margin-top:20px}.lang{float:right}.danger{padding:12px;border:1px solid #b33;border-radius:8px;margin-top:16px}#googleButton{margin-top:12px;min-height:44px}
</style></head><body><div class="wrap"><main>
<a class="lang" href="${ko ? "/en/" : "/"}">${ko ? "English" : "한국어"}</a>
<h1>${escapeHtml(copy.title)}</h1><p>${escapeHtml(copy.intro)}</p><p class="notice">${escapeHtml(copy.notice)}</p>
<form id="caseForm">
<label for="requestType">${escapeHtml(copy.requestType)}</label><select id="requestType">${options.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("")}</select>
<label for="requestText">${escapeHtml(copy.text)}</label><textarea id="requestText" maxlength="4096"></textarea>
<div id="deletionConfirm" class="danger" hidden><label><input id="confirmed" type="checkbox"> ${escapeHtml(copy.deleteConfirm)}</label></div>
<div id="turnstile-widget"></div><button id="anonymousSubmit" type="submit">${escapeHtml(copy.submit)}</button>
<button id="googleStart" type="button" hidden>${escapeHtml(copy.google)}</button><div id="googleButton"></div>
</form>
<section id="receiptResult" hidden><h2>${escapeHtml(copy.receipt)}</h2><p class="muted">${escapeHtml(copy.receiptWarning)}</p><div id="opened" class="result"></div></section>
<hr><form id="viewForm"><label for="receiptInput">${escapeHtml(copy.receipt)}</label><input id="receiptInput" type="text" autocomplete="off"><button type="submit">${escapeHtml(copy.view)}</button></form><div id="viewResult" class="result" hidden></div>
</main></div>
<script nonce="${nonce}">const PORTAL=${runtimeConfig};let widget=null;let pending=null;
const byId=(id)=>document.getElementById(id);const anonymous=(type)=>type==='inquiry'||type==='identity_issue';
async function call(path,body){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data?.error?.message||'Request failed');return data}
function payload(){const type=byId('requestType').value;const common={locale:PORTAL.locale,noticeVersion:PORTAL.noticeVersion};if(type==='account_deletion')return {...common,kind:'account_deletion',confirmed:byId('confirmed').checked};const base={...common,requestText:byId('requestText').value};if(type==='inquiry')return {...base,kind:'inquiry'};return {...base,kind:'privacy_request',privacyAction:type}}
function updateMode(){const type=byId('requestType').value;const isAnonymous=anonymous(type);byId('anonymousSubmit').hidden=!isAnonymous;byId('googleStart').hidden=isAnonymous;byId('deletionConfirm').hidden=type!=='account_deletion';byId('googleButton').replaceChildren();if(isAnonymous&&window.turnstile&&widget===null)widget=turnstile.render('#turnstile-widget',{sitekey:PORTAL.turnstileSiteKey,action:'request_case'});if(!isAnonymous&&widget!==null){turnstile.remove(widget);widget=null}}
window.onTurnstileLoad=updateMode;byId('requestType').addEventListener('change',updateMode);
function showOpened(data){const link=location.origin+location.pathname+'#receipt='+encodeURIComponent(data.receipt);byId('receiptResult').hidden=false;byId('opened').textContent=data.receipt+'\\n'+link+'\\n\\n'+JSON.stringify({status:data.status,outcomeCode:data.outcomeCode,responseText:data.responseText},null,2);byId('receiptInput').value=data.receipt}
byId('caseForm').addEventListener('submit',async(event)=>{event.preventDefault();try{const token=window.turnstile&&widget!==null?turnstile.getResponse(widget):'';const data=await call('/api/cases',{...payload(),turnstileToken:token});showOpened(data);turnstile.reset(widget)}catch(error){byId('opened').textContent=error.message;byId('receiptResult').hidden=false}});
byId('googleStart').addEventListener('click',async()=>{try{pending=payload();if(pending.kind==='account_deletion'&&!pending.confirmed)throw new Error('${ko ? "삭제 확인이 필요합니다." : "Deletion confirmation is required."}');const challenge=await call('/api/google-challenge',{});google.accounts.id.initialize({client_id:challenge.clientId,nonce:challenge.nonce,auto_select:false,callback:async(result)=>{try{const data=await call('/api/cases',{...pending,google:{attemptId:challenge.attemptId,nonce:challenge.nonce,token:result.credential}});showOpened(data)}catch(error){byId('opened').textContent=error.message;byId('receiptResult').hidden=false}}});google.accounts.id.renderButton(byId('googleButton'),{type:'standard',theme:'outline',size:'large',text:'continue_with',locale:PORTAL.locale})}catch(error){byId('opened').textContent=error.message;byId('receiptResult').hidden=false}});
async function viewReceipt(receipt){try{const data=await call('/api/cases/view',{receipt});byId('viewResult').textContent=JSON.stringify(data,null,2)}catch(error){byId('viewResult').textContent=error.message}byId('viewResult').hidden=false}
byId('viewForm').addEventListener('submit',(event)=>{event.preventDefault();viewReceipt(byId('receiptInput').value.trim())});const hash=new URLSearchParams(location.hash.slice(1));const fromHash=hash.get('receipt');if(fromHash){history.replaceState(null,'',location.pathname+location.search);byId('receiptInput').value=fromHash;viewReceipt(fromHash)}updateMode();
</script><script nonce="${nonce}" src="https://accounts.google.com/gsi/client" async></script><script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit" async defer></script>
</body></html>`;
}

function adminPage(
  config: RequestPortalConfig,
  cases: Awaited<ReturnType<ReturnType<typeof createRequestCases>["review"]>>,
): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const rows = cases
    .map(
      (item) => `<article><h2>${escapeHtml(item.kind)} · ${escapeHtml(item.caseId)}</h2>
<p>${escapeHtml(item.scope)} · ${escapeHtml(item.locale)} · ${escapeHtml(item.createdAt)}</p>
<pre>${escapeHtml(item.requestText ?? "(no request text)")}</pre>
<form data-case="${escapeHtml(item.caseId)}"><label>Outcome code<input name="outcomeCode" value="fulfilled" required></label><label>Response<textarea name="responseText" maxlength="4096" required></textarea></label><label>Status<select name="status"><option value="completed">completed</option><option value="rejected">rejected</option></select></label><button>Resolve once</button></form></article>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Request review · ${escapeHtml(config.organizationName)}</title><style nonce="${nonce}">body{font-family:system-ui,sans-serif;max-width:900px;margin:auto;padding:24px}article{border:1px solid #ccc;border-radius:12px;padding:18px;margin:18px 0}label{display:block;margin:12px 0}input,textarea,select{display:block;box-sizing:border-box;width:100%;padding:9px}textarea{min-height:120px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:12px}button{padding:10px 14px}</style></head><body><h1>Pending request cases</h1>${rows || "<p>No pending cases.</p>"}<div id="result"></div><script nonce="${nonce}">document.querySelectorAll('form[data-case]').forEach((form)=>form.addEventListener('submit',async(event)=>{event.preventDefault();const data=Object.fromEntries(new FormData(form));const response=await fetch('/admin/cases/'+encodeURIComponent(form.dataset.case)+'/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});const result=await response.json();document.getElementById('result').textContent=response.ok?'Resolved '+result.caseId:(result?.error?.message||'Request failed');if(response.ok)form.closest('article').remove()}));</script></body></html>`;
}

export function createRequestPortalApp(dependencies: RequestPortalDependencies = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const googleVerifier = dependencies.verifyGoogleIdentity ?? verifyGoogleIdentity;
  const turnstileVerifier = dependencies.verifyTurnstile ?? verifyTurnstile;
  const adminVerifier = dependencies.verifyAdmin ?? verifyAdmin;

  app.use("*", async (context, next) => {
    await next();
    if (!context.res.headers.get("content-type")?.startsWith("text/html")) {
      context.header(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    context.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  });

  app.get("/", async (context) => {
    const { config } = await portalContext(context.req.raw, context.env);
    const html = userPage(config, "ko");
    const nonce = html.match(/nonce="([a-f0-9]+)"/u)?.[1] ?? "invalid";
    return context.html(html, 200, { ...portalHeaders(nonce), "Content-Language": "ko" });
  });
  app.get("/en/", async (context) => {
    const { config } = await portalContext(context.req.raw, context.env);
    const html = userPage(config, "en");
    const nonce = html.match(/nonce="([a-f0-9]+)"/u)?.[1] ?? "invalid";
    return context.html(html, 200, { ...portalHeaders(nonce), "Content-Language": "en" });
  });

  app.post("/api/google-challenge", async (context) => {
    const { config } = await portalContext(context.req.raw, context.env);
    requireSameOrigin(context.req.raw, config);
    await limit(
      context.env,
      `request-google:${context.req.header("cf-connecting-ip") ?? "unknown"}`,
    );
    const body = z
      .object({})
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!body.success) throw new PublicError(400, "VALIDATION_ERROR", "Invalid request");
    const challenge = await createPortalGoogleChallenge(context.env, config);
    return context.json({
      attemptId: challenge.attemptId,
      nonce: challenge.nonce,
      clientId: challenge.webClientId,
      expiresAt: challenge.expiresAt,
    });
  });

  app.post("/api/cases", async (context) => {
    const { config, databases } = await portalContext(context.req.raw, context.env);
    requireSameOrigin(context.req.raw, config);
    await limit(context.env, `request-open:${context.req.header("cf-connecting-ip") ?? "unknown"}`);
    const body = await readJson(context.req.raw);
    const anonymousParsed = anonymousCaseSchema.safeParse(body);
    const cases = createRequestCases(databases, config);
    if (anonymousParsed.success) {
      await turnstileVerifier(anonymousParsed.data.turnstileToken, context.env, config);
      const { turnstileToken: _token, ...input } = anonymousParsed.data;
      return context.json(await cases.open(input as OpenCase, { kind: "anonymous" }), 201);
    }
    const googleParsed = googleCaseSchema.safeParse(body);
    if (!googleParsed.success) {
      throw new PublicError(400, "VALIDATION_ERROR", "Invalid request case");
    }
    const identity = await googleVerifier(
      parseGoogleProof(googleParsed.data.google),
      context.env,
      config,
    );
    const {
      google: _google,
      confirmed: _confirmed,
      ...input
    } = googleParsed.data.kind === "account_deletion"
      ? googleParsed.data
      : { ...googleParsed.data, confirmed: undefined };
    return context.json(await cases.open(input as OpenCase, { kind: "google", identity }), 201);
  });

  app.post("/api/cases/view", async (context) => {
    const { config, databases } = await portalContext(context.req.raw, context.env);
    requireSameOrigin(context.req.raw, config);
    await limit(context.env, `request-view:${context.req.header("cf-connecting-ip") ?? "unknown"}`);
    const parsed = viewSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) throw new PublicError(400, "VALIDATION_ERROR", "Invalid receipt");
    return context.json(await createRequestCases(databases, config).view(parsed.data.receipt));
  });

  app.get("/admin/", async (context) => {
    const { config, databases } = await portalContext(context.req.raw, context.env);
    const admin = await adminVerifier(context.req.raw, context.env, config);
    const cases = createRequestCases(databases, config);
    const html = adminPage(config, await cases.review(admin));
    const nonce = html.match(/nonce="([a-f0-9]+)"/u)?.[1] ?? "invalid";
    return context.html(html, 200, portalHeaders(nonce));
  });

  app.post("/admin/cases/:id/resolve", async (context) => {
    const { config, databases } = await portalContext(context.req.raw, context.env);
    requireSameOrigin(context.req.raw, config);
    const admin = await adminVerifier(context.req.raw, context.env, config);
    const parsed = resolveSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) throw new PublicError(400, "VALIDATION_ERROR", "Invalid resolution");
    return context.json(
      await createRequestCases(databases, config).resolve(
        { caseId: context.req.param("id"), ...parsed.data },
        admin,
      ),
    );
  });

  return app;
}

export async function runRequestPortalMaintenance(env: Env, scheduledTime: number): Promise<void> {
  if (!requestPortalEnabled(env)) return;
  const config = requestPortalConfig(env);
  const databases = { DB: env.DB, REQUEST_DB: requestPortalDatabase(env) };
  await createRequestCases(databases, config).purge(new Date(scheduledTime));
}
