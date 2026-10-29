# 出站代理

设置 `SEX_PROXY_URL`（`http://` 或 `https://`，可带 `user:pass@`）后，抓取用户给的 URL 都经过这个代理：HTTP 路径用 Bun `fetch` 自带的 `proxy` 选项，浏览器按[浏览器](browser.md)一节的方式配置：Lightpanda 和本机的外部浏览器经 `EgressProxy` 串联到它，远程的外部浏览器直接用它。凭据只从环境变量读，没有命令行参数，避免出现在进程列表里；Lightpanda 的命令行上也不再有代理（它连的是 `EgressProxy`，凭据是每次抓取随机生成的）。

SSRF 防护在代理之前仍然生效：

- 每次请求（包括每一跳重定向）发出前，sex 先在本机解析并检查目标，内网、回环、link-local 地址照旧拒绝（`PRIVATE_NETWORK_BLOCKED`），被拒的请求不会到达代理。浏览器的请求在 `EgressProxy`（或远程浏览器的 CDP request guard）里同样先检查。
- 本机解析不出来的域名在走代理时直接拒绝（`SCRAPE_DNS_RESOLUTION_ERROR`），否则只有代理的 DNS 才认识的内部域名会绕过检查。代价是只能靠代理解析的域名抓不了。
- 请求里的 `Proxy-Authorization` 头在走代理时被丢弃，不能借此改变代理的身份。

**SearXNG**：sex 自己启动 SearXNG 时（没有 `SEX_SEARXNG_URL`），`SEX_PROXY_URL` 同样会写进它的 `outgoing.proxies`，SearXNG 去搜索引擎的请求走这个代理。这里的目标是搜索引擎，不是用户提交的 URL，所以没有 SSRF 检查。`SEX_SEARXNG_SETTINGS` 是你自己的文件时 sex 不改它；外部 SearXNG 由你自己配置。

**LLM 和 S3 不走 `SEX_PROXY_URL`**：`SEX_LLM_BASE_URL` 和 `SEX_DOCUMENTS_URL` 的 S3 端点都是运维方自己配置的地址，不是用户提交的 URL。确实需要走代理时，用 Bun 认的标准环境变量 `HTTP_PROXY` / `HTTPS_PROXY`（小写也行，`NO_PROXY` 生效），已用 Bun 1.4.3 实测：`fetch`（LLM 请求用的就是它）和 `Bun.S3Client` 都读这些变量，`http://` 地址看 `HTTP_PROXY`，`https://` 地址看 `HTTPS_PROXY`。注意它是整个进程范围的：sex 访问本机 SearXNG（`127.0.0.1`）的请求也会走代理，所以要同时设 `NO_PROXY=127.0.0.1,localhost`；没显式用 `SEX_PROXY_URL` 的 `fetch` 同样受影响。

**stealth 重试**（`SEX_STEALTH_PROXY_URL`）：设置后，普通抓取被拦截时换这个代理重试一次。判断“被拦截”的规则只有一处（`packages/errors/src/index.ts` 的 `isBlocked`）：响应状态是 403 或 429，或者抛出的错误在错误目录里标了 `blocked`（目前只有 `SCRAPE_SITE_ERROR`，连接被重置 / 断开）。别的状态、`PRIVATE_NETWORK_BLOCKED` 这类我们自己的拒绝都不重试。

- 重试在这次抓取的同一个 `Deadline` 里，剩下不到 2 秒就不重试；超时照常是 `SCRAPE_TIMEOUT`。重试本身失败时保留第一次的结果，`warning` 里说明。
- 用了 stealth 的文档，`metadata.proxyUsed` 是 `"stealth"`，`warning` 写明重试过；没重试或重试没被采用是 `"basic"`。重试得到的响应不管状态是什么都会被采用（再被拦就是第二次的 403）。
- 请求 `proxy: "basic"` 不重试；`proxy: "stealth"` 从第一次请求就走 stealth 代理，并且用纯 HTTP（不用浏览器，`warning` 说明，带 `actions` 是 400）；`auto`、`enhanced` 和不传一样。两个代理相同时不重试。
- 浏览器只有启动时那一个代理，所以浏览器渲染出的页面被拦截（403 / 429，没有 `actions`）时，换 stealth 代理做一次纯 HTTP 抓取，这次没被拦截才替换浏览器的结果（脚本没有执行，`warning` 说明）。
- SSRF 规则和 `SEX_PROXY_URL` 完全一样：每一跳先在本机解析并检查，本机解析不了的域名拒绝，调用方的 `Proxy-Authorization` 丢弃，由 stealth 代理解析域名所以无法固定 IP（残留风险同下）。缓存键不含代理，stealth 取回的 2xx 页面会和其他页面一样进缓存。

**残留风险**：走代理时由代理解析域名，连接无法固定到 sex 检查过的 IP（`pinToAddress` 只在直连时有效）。DNS rebinding（sex 检查时返回公网 IP，代理查询时返回内网 IP）在 sex 这一侧防不住，需要代理自己拒绝内网目标，例如 squid 的 ACL，或带 SSRF 防护的代理；sex 的检查是对它的补充，不是替代。浏览器串联在 `EgressProxy` 后面时同理（`EgressProxy` 在本机检查一次，上游再解析一次）。远程的 `--cdp-url` 浏览器直接连上游代理，它的 service worker、WebSocket 等不经过 request interception 的网络路径只能靠网络层（代理或防火墙）限制。
