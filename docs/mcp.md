# MCP

工具：`web_fetch`、`web_search`、`web_map`、`web_crawl`、`web_crawl_status`、`web_crawl_cancel`、`web_batch_scrape`、`web_batch_status`、`web_extract`、`web_extract_status`。参数沿用 firecrawl-mcp，只是把 `firecrawl_` 前缀换成了 `web_`（例如 `firecrawl_scrape` → `web_fetch`）。`SEX_MCP_TOOL_NAMES=firecrawl` 把 firecrawl-mcp 里也有的六个工具改回它的名字（`firecrawl_scrape`、`firecrawl_search`、`firecrawl_map`、`firecrawl_crawl`、`firecrawl_check_crawl_status`、`firecrawl_extract`，核对自 firecrawl/firecrawl-mcp-server 的 `src/server.ts`），按工具名写的权限白名单和提示词可以沿用；firecrawl-mcp 现在没有 batch、取消 crawl 和 extract 状态这几个工具，它们仍叫 `web_*`。服务端基于 `@modelcontextprotocol/server` v2。

MCP 只通过 streamable HTTP 提供：先运行 `sex serve`，端点就是 `http://host:3002/mcp`（默认 `http://127.0.0.1:3002/mcp`），和 HTTP API 在同一个进程、同一个端口上。没有 stdio 传输，也没有 `sex mcp` 命令。

客户端配置，以 Claude Code 为例：

```bash
claude mcp add --transport http sex http://127.0.0.1:3002/mcp
```

或者写进 JSON 配置（例如 Claude Code 项目里的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "sex": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp"
    }
  }
}
```

只支持 stdio 的客户端（例如 Claude Desktop 的配置文件）需要用 `mcp-remote` 这类 stdio 转 HTTP 的桥接，或者改用客户端自带的远程 / 自定义 connector 功能。

MCP 工具的默认值比 HTTP API 保守，因为结果会进入 LLM 上下文：

- `web_crawl` 的 `limit` 默认 20（HTTP API 默认 10000）。
- `web_map` 的 `limit` 默认 200（HTTP API 默认 5000）。
- `web_crawl_status` 每次返回约 200000 个字符的页面，超出时用 `skip` 翻页；单个超大页面会被截断并标记 `truncated`。
- `web_extract` 最多等待 5 分钟，超时后取消任务并返回错误；`async: true` 时只返回任务 id，用 `web_extract_status` 查结果。
- `web_batch_status` 的分页和截断同 `web_crawl_status`。MCP 的 batch / extract 沿用 HTTP 的 schema，包括 `webhook`。

HTTP 传输（`serve`，端点 `/mcp`）始终是无状态的（SDK v2 的行为）。它和 HTTP API 在同一个进程、同一个端口上，所以 `/health`（JSON）、Host / Origin 检查和 CORS 设置也是同一套，见 [HTTP API](api.md)。
