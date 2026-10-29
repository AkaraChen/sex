// Errors are this class (bundled in every package, recognised across them by AppError.isInstance, never instanceof).
export { AppError, type ErrorCode } from "@searxng-js/sex-errors";
export { AdBlockList, loadAdBlockList, registerEmbeddedAdblock, siteOf } from "./adblock.ts";
export { BrowserPool, type BrowserPoolOptions, lightpandaArgv, pdeathsigWrapper, registerEmbeddedLightpanda } from "./browser.ts";
export { type BrowserKind, browserKind, contextProxy, type EgressPlan, isLoopbackHost, planEgress } from "./browser-egress.ts";
export {
  AdBlockPolicy,
  type AppliedPolicies,
  applyRequestPolicies,
  CREDENTIAL_HEADERS,
  MediaBlockPolicy,
  OriginScopedCredentialsPolicy,
  type PolicyDecision,
  type PolicyOutcome,
  type PolicyPage,
  type PolicyRequest,
  PrivateNetworkPolicy,
  parseCookieHeader,
  type RequestPolicy,
  type RequestPolicyOptions,
  RequestPolicyPipeline,
  type SplitHeaders,
  splitUserHeaders,
} from "./browser-policy.ts";
export {
  EGRESS_HEADER,
  type EgressLease,
  EgressProxy,
  type EgressSessionOptions,
} from "./egress-proxy.ts";
