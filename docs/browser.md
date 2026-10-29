# 浏览器

- **`--lightpanda`**（`SEX_LIGHTPANDA=1`）：sex 自己 spawn 一个 Lightpanda 子进程。`serve` 启动时预热，其它命令在第一次用到浏览器时才启动；子进程退出后，下一次请求会自动重新启动；sex 退出时一起退出。连续启动失败（60 秒内 3 次，例如二进制起不来）后，30 秒内直接返回 `502 BROWSER_UNAVAILABLE`，不会对着坏掉的二进制反复 spawn。
- **`--cdp-url ws://...`**（`SEX_CDP_URL`）：连接已经在运行的 CDP 浏览器，比如 Chrome。sex 不启动任何进程；地址是回环时按“本机的外部浏览器”处理（Chrome 专用，见下面的表），要用 Lightpanda 请用 `--lightpanda`；和 `--lightpanda` 同时设置时以 `--cdp-url` 为准。
- 都不设：不用浏览器。

`dist/sex`（以及 Docker 镜像）内置了 Lightpanda，`--lightpanda` 开箱即用：第一次用到时解压到 `$XDG_CACHE_HOME/sex/lightpanda-<版本>-<hash>/`（约 76 MB），之后复用。版本和每个平台的 SHA-256 固定在 `packages/browser/scripts/lightpanda.ts`（目前是 1.0.2），`bun run build` 第一次会从 GitHub Releases 下载并校验，缓存在 `$XDG_CACHE_HOME/sex-build`，压缩后让 `dist/sex` 增大约 23 MB。预编译版本只有 Linux x64 / arm64（glibc ≥ 2.35）和 macOS x64 / arm64，Windows 和 musl 没有。

从源码运行（`bun run dev`）时没有内置的二进制，需要自己放到 PATH 上，或用 `--lightpanda-path`（`SEX_LIGHTPANDA_PATH`）指定；`--lightpanda-path` 也会覆盖内置的版本：

```bash
gh release download 1.0.2 -R lightpanda-io/browser -p lightpanda-x86_64-linux -O lightpanda && chmod +x lightpanda
bun run dev fetch https://example.com --lightpanda --lightpanda-path ./lightpanda
```

**子进程的回收**：`SIGINT` / `SIGTERM` 时 sex 会先关掉子进程再退出，但 `SIGKILL` 无法被捕获。所以在 Linux 上，sex 用 `setpriv --pdeathsig TERM -- lightpanda serve ...` 启动子进程（`setpriv` 属于 util-linux ≥ 2.33，Debian / Ubuntu 和 Docker 镜像里都有）：sex 被 `kill -9` 后，内核会给子进程发 `SIGTERM`，不会留下孤儿。macOS 没有对应机制（pdeathsig 是 Linux 特有的），Linux 上没有 `setpriv` 时也一样，sex 只能直接 spawn，此时 `kill -9` sex 会留下孤儿 Lightpanda 进程，需要自己清理。`lightpanda started` 日志里的 `spawn=setpriv` / `spawn=direct` 标明了实际用的是哪种方式。

**出站规则与执行点**：出站规则只有一份（sex-egress 的 `EgressPolicy`：解析域名，任何一个地址是内网、回环、link-local（含云元数据 `169.254.169.254`）就拒绝，通过后给出要固定连接的 IP，按 host 缓存 30 秒）。`safeFetch`、浏览器都问它；浏览器能在哪里执行这条规则，取决于浏览器本身：

| 浏览器 | SSRF 检查 | 广告拦截 | 凭据限定 / 媒体拦截 |
|---|---|---|---|
| Lightpanda（`--lightpanda`） | 子进程的 `--block-private-networks`；设了 `SEX_PROXY_URL` 时改由 `EgressProxy` | CDP 拦截 | CDP 拦截，按需开 |
| 本机的外部浏览器（`--cdp-url`，地址是回环：`127.0.0.1`、`localhost`、`::1`） | `EgressProxy` | `EgressProxy` | CDP 拦截，按需开 |
| 远程的外部浏览器（`--cdp-url`，其它地址） | CDP request guard | CDP 拦截 | CDP 拦截，按需开 |

“按需开”：只有带了 `Authorization` / `Proxy-Authorization` 的请求或设了 `SEX_BLOCK_MEDIA` 时才打开 CDP 拦截；表里没有 CDP 的格子不会因为 SSRF 或广告而打开它。`--allow-private-network` 打开时三条路径都不做 SSRF 检查（和以前一样）。

**`EgressProxy`**（本机的外部浏览器，以及 Lightpanda 配了 `SEX_PROXY_URL` 时）：sex 在 `127.0.0.1` 的随机端口起一个转发代理（`node:http`，随 `BrowserPool` 懒启动，`engine.close()` 时关闭），浏览器的所有流量都经过它，所以文档、重定向、子资源、service worker、WebSocket 都在检查范围内，这是 CDP 拦截做不到的。

- HTTPS（`CONNECT`）和 HTTP（绝对 URL 转发）都先过 `EgressPolicy`，再连到它验证过的 IP（不会再解析一次域名，DNS rebinding 无从下手）；转发保留原始 `Host`，去掉 hop-by-hop 头和 `Proxy-*` 头，不跟随重定向（原样交还浏览器，浏览器跟随时每一跳重新检查）。
- 认证：每次抓取（每个 browser context）一组随机凭据（`Proxy-Authorization: Basic`，`timingSafeEqual` 比较），对应这次抓取的策略（广告表、上游代理）；抓取结束就注销，并关掉这次抓取的所有连接。同机其它进程没有凭据，用不了这个代理。Chrome 用 `page.authenticate` 回答 407，Lightpanda 把凭据写在 `proxyServer` 的 URL 里（它不回应 CONNECT 的 407，但会主动带上）；凭据不再出现在 Lightpanda 的命令行上。
- Chrome 默认不让回环和 link-local 地址走代理（直连），所以每个 context 都带 `proxyBypassList: ["<-loopback>"]`，否则 `127.0.0.1`、`169.254.169.254` 会绕过检查。
- 被拒的主文档报 `PRIVATE_NETWORK_BLOCKED`（域名不存在报 `SCRAPE_DNS_RESOLUTION_ERROR`）；被拒的子资源只是加载失败，页面照常返回。
- 广告：`blockAds` 在这条路径上按 host 拒绝，查的是同一份 EasyList 表（见下）。代理看不到“这是不是主文档导航”，所以目标页自己的 host 永远不拦；页面重定向到表里的域名时会被拦（CDP 路径则不拦主文档导航）。
- 失败时关闭：代理起不来是 `BROWSER_UNAVAILABLE`，不会退回无防护的浏览器。浏览器和 sex 不在同一个网络命名空间里（例如端口转发到容器里的 Chrome，`--cdp-url` 写的是 `127.0.0.1`）时，浏览器连不上这个回环代理，页面加载会失败（同样是关闭，不是放行）；这种部署请让 `--cdp-url` 用浏览器所在的主机名，走远程那一行。
- `--cdp-url` 按 Chrome 处理。接外部 Lightpanda 时请用 `--lightpanda`，让 sex 自己启动。
- 上游代理：设了 `SEX_PROXY_URL` 时，`EgressProxy` 把请求串到它后面（HTTP 转发走上游，`CONNECT` 先向上游发 `CONNECT`，带上游的凭据）。这时域名由上游解析，无法固定 IP：沿用[出站代理](proxy.md)的语义，先在本机检查一次，本机解析不了的域名拒绝；残留风险见该节。

**Lightpanda**：没有 `SEX_PROXY_URL` 时不经过 `EgressProxy`（少一跳），内网保护靠子进程的 `--block-private-networks`（Lightpanda 在 DNS 解析之后拦内网地址，主文档和子资源都拦）。设了 `SEX_PROXY_URL` 时，Lightpanda 的这个选项会把回环代理一起拒掉，所以不带它，改由 `EgressProxy` 检查并串联上游。

**远程的外部浏览器**：sex 连不到它那边的回环，只能用 CDP request guard：每个 origin 过一次 `EgressPolicy`，被拒的请求中止。它看不到 interception 打开之前的请求、service worker 和 WebSocket；这些要靠浏览器所在主机的网络层（防火墙、或在那台机器上套一个带 SSRF 防护的代理）限制。设了 `SEX_PROXY_URL` 时，浏览器直接用它（`createBrowserContext({ proxyServer })`，用户名密码由 `page.authenticate` 回答 407），guard 仍在前面。

**请求头与凭据**：请求里的 `headers` 在浏览器路径上的处理和 HTTP 路径一致，凭据只发给目标页所在的 origin（协议 + 主机 + 端口）：

- `Authorization` / `Proxy-Authorization` 只附加在发往目标 origin 的请求上（包括它的子资源），CDN、统计、广告等第三方域名收不到；重定向到其它 origin 后也不再带上。这需要 CDP request interception，所以即使开了 `--allow-private-network` 也会启用。经过代理（`EgressProxy` 或 `SEX_PROXY_URL`）的请求里，调用方给的 `Proxy-Authorization` 只可能是写给代理的，所以丢弃，不发给目标。
- `Cookie` 拆开写进浏览器的 cookie jar，只属于目标页的主机（host-only，不猜“末两段”域名），浏览器只会发给这个主机。
- 其它头（如 `Accept-Language`）仍对页面的所有请求生效。页面自己设置的头不受影响。
- 浏览器不支持 request interception 时：需要 CDP request guard（远程的外部浏览器）或带了 `Authorization` / `Proxy-Authorization` 的请求返回 `501 BROWSER_INTERCEPTION_UNSUPPORTED`，不会退回“发给所有域名”。不支持 `Network.setCookies` 时，`Cookie` 改为和 `Authorization` 一样只附加在目标 origin 的请求上（同样需要 request interception）。
- Lightpanda 1.0.2 已实测：支持带 headers 的 `Fetch.continueRequest` 和 `Network.setCookies`。它对 request interception 里暂停的请求会把 `Cookie` 头少报一个字符，所以 sex 不会把它传回浏览器，由 cookie jar 负责发送。
- `X-Api-Key` 这类自定义的鉴权头不在上面的名单里，仍会发给页面的所有请求；需要限定范围的话请用 `Authorization`。

**广告与追踪器拦截（`blockAds`）**：只作用于浏览器路径，默认开启（和 Firecrawl 一致），请求里传 `blockAds: false` 关闭。

- 数据：EasyList 和 EasyPrivacy 里的域名规则，也就是 `||domain^`（可带 `$third-party`）和例外规则 `@@||domain^`，约 9 万条。带路径、通配符、其它选项的规则和页面元素隐藏规则不用。
- 匹配：按域名的 label 从后往前做后缀匹配（`ads.example.com` 命中 `cdn.ads.example.com`，不命中 `badads.example.com`），不是子串匹配；例外规则优先于拦截规则。`$third-party` 规则只在请求离开目标页所在的可注册域名时生效（没有 public suffix list，用“两段或 `co.uk` 式三段”近似）。
- 范围：子资源和 iframe 被拦截时直接中止；目标页本身的导航（包括重定向）永远不拦（`EgressProxy` 上的差别见上）。浏览器不支持 request interception（部分 `--cdp-url` 浏览器）且没有别的策略需要它时，静默不拦截，不报错。
- 数据怎么来：`packages/browser/scripts/adblock.ts` 固定了 EasyList 仓库的一个提交，按它的模板拉取各个子列表，提取域名后得到一个纯文本表，并固定该表的 SHA-256。`bun run build` 把它 zstd 压缩（约 600 KB）嵌入 `dist/sex`；第一次用到浏览器时解压并建 `Set`（约 30 ms，常驻内存增加约 10 MiB），之后每次查询不到 1 µs。从源码运行时，第一次用到会下载并校验，缓存在 `$XDG_CACHE_HOME/sex-build`；下载失败只打一条警告，不拦截，不影响抓取。升级规则：改 `EASYLIST_COMMIT`，运行 `bun packages/browser/scripts/adblock.ts` 取新 hash 填进 `ADBLOCK_TABLE_SHA256`。
- 开销：CDP 路径要让浏览器把每个请求交给 sex 决定，这一步（CDP 往返）才是成本，查表本身可以忽略；本机的外部浏览器上广告在 `EgressProxy` 里按 host 拒绝，不需要 CDP 拦截。开了 `--allow-private-network`（`search` / `fetch` 默认就开）且没有其它策略时，Lightpanda 和远程浏览器上的 `blockAds` 会把 CDP 拦截打开。在 Lightpanda 上，一个有 50 个子资源且没有一个命中广告表的页面，实测增加约 2–5%（约 80 µs / 请求）；真实的广告多的新闻页面里，被拦掉 4–13 个请求，页面反而更快，正文不变。复测：`bun packages/browser/scripts/bench-adblock.ts`。
- **`SEX_BLOCK_MEDIA`**（`--block-media`）：另外拦截图片和音视频请求（按资源类型，不是扩展名），默认关。文本抓取不需要这些字节；`screenshot` 本来就不支持。

**EasyList 的出处与许可**：广告域名表来自 [EasyList](https://easylist.to/) 和 EasyPrivacy（[easylist/easylist](https://github.com/easylist/easylist)），双许可 GPLv3 / CC BY-SA 3.0。sex 只取其中的域名，派生出的域名表随 `dist/sex` 一起分发；具体的提交和校验和见 `packages/browser/scripts/adblock.ts`。
