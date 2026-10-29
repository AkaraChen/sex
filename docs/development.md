# 开发

```bash
bun run verify    # bun check && bun run lint && bun test
bun run format    # biome --write
bun test          # 单元 + 集成测试（本地 fixture 站点、mock SearXNG、mock LLM，不依赖外网；packages/sex/test/docs.test.ts 会真的跑 here-docs，平台不支持时自动跳过）
```

可选的集成测试需要外部服务，没有设置对应变量时会跳过：

```bash
SEX_TEST_CDP_URL=http://127.0.0.1:9222 bun test packages/sex/test/browser.test.ts packages/sex/test/egress-browser.test.ts   # 需要一个正在运行的 CDP 浏览器（Chrome）；egress-browser 是真浏览器经 EgressProxy 的 SSRF 用例
SEX_TEST_SEARXNG=1 bun test packages/core/test/searxng.test.ts                   # 启动真的 SearXNG 二进制（可用 SEX_TEST_SEARXNG_PATH 指定），需要外网
SEX_TEST_LIGHTPANDA_PATH=./lightpanda bun test packages/sex/test/browser.test.ts    # 让 sex 自己 spawn 这个 Lightpanda 二进制（取法见「浏览器」一节），跑同一套用例，另加子进程用例：首次 spawn、被杀后重启、close 后无残留、sex 被 SIGKILL 后无孤儿
```

其它检查：`bun check`（类型检查），`bun run lint`（Biome）。
