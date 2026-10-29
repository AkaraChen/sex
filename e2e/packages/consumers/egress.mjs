import { safeFetch } from "@searxng-js/sex-egress";
import { cfg, isAppError, report } from "./common.mjs";

const base = { signal: AbortSignal.timeout(10_000), proxy: undefined, userAgent: "e2e/1.0" };
const ok = await safeFetch(`${cfg.siteUrl}/`, { ...base, allowPrivateNetwork: true });
let refused;
try {
  await safeFetch(`${cfg.siteUrl}/private`, { ...base, allowPrivateNetwork: false });
} catch (e) {
  refused = { isAppError: isAppError(e), code: e.code, status: e.status, retryable: e.retryable };
}
report({ status: ok.status, contentType: ok.contentType, text: new TextDecoder().decode(ok.body), refused });
