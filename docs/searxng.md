# SearXNG

不设 `SEX_SEARXNG_URL` 时，sex 自己运行 SearXNG：`serve` 启动时就拉起（冷启动约 1.5 秒，失败则报错退出），`search` / `fetch` 这类一次性命令在第一次搜索时才启动，命令结束时停掉。子进程监听 `127.0.0.1` 的随机端口，每次启动用随机 secret；它退出后下一次搜索会重新启动，60 秒内连续 3 次启动失败则暂停 30 秒（期间搜索返回 `502 SEARCH_BACKEND_UNAVAILABLE`）。sex 被 SIGKILL 时 SearXNG 也会退出（它监听自己的 stdin 管道）。

- 二进制：默认用 `@searxng-js/<平台>` 包里的（`bun install` 按平台装上，`bun run build` 把目标平台的嵌进 `dist/sex`，约 32 MB），第一次运行时解包到 `$XDG_CACHE_HOME/searxng-js/`，它自己再解压到 `$XDG_CACHE_HOME/searxng/`（约 130 MB）。`SEX_SEARXNG_PATH` 可以换成别的二进制。
- 平台：只有 linux-x64（glibc ≥ 2.35）、macOS arm64、Windows x64 有预编译二进制。其它平台（包括 linux-arm64 的 Docker 镜像和 musl）请设 `SEX_SEARXNG_URL`。
- 配置：默认是一份最小的 `settings.yml`（继承 SearXNG 默认值，开启 JSON，关闭 limiter 和 image proxy）。要调整引擎等设置，用 `SEX_SEARXNG_SETTINGS` 指定自己的文件，并保留 `search.formats` 里的 `json`；端口、监听地址和 secret 总是由 sex 设置。设了 `SEX_PROXY_URL` 且用的是这份默认配置时，sex 会在里面加上 `outgoing.proxies`（`all://` 指向该代理），SearXNG 对搜索引擎的请求就走代理；配置文件只在启动时写入一个 `0600` 的临时文件，SearXNG 读完即删，代理凭据不进日志。你自己用 `SEX_SEARXNG_SETTINGS` 提供的文件原样使用，sex 不碰其中的 `outgoing`（要走代理请自己写 `outgoing.proxies`，日志里会提示一次）；外部 SearXNG（`SEX_SEARXNG_URL`）也不处理。
- 资源：常驻内存约 220 MB（onefile 启动器加 SearXNG 进程）。
- 外部实例：设 `SEX_SEARXNG_URL`（或 `--searxng-url`）后不再启动子进程，需要在它的 `settings.yml` 里开启 json format。
- 许可：SearXNG 二进制是 AGPL-3.0-or-later。分发 `dist/sex` 或 Docker 镜像时，需要同时提供对应源码（固定版本的 SearXNG 加 [AkaraChen/searxng](https://github.com/AkaraChen/searxng) 的构建脚本），见 `node_modules/@searxng-js/<平台>/THIRD-PARTY-NOTICES.md`。
