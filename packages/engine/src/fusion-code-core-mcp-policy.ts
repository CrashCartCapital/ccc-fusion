export interface ApprovedMcpDiscoveryTool {
  serverName: string;
  toolName: string;
}

export const FUSION_CODE_CORE_MCP_SERVER_NAME = "fusion-code-core";

/**
 * Exact read-only catalog approved for CCC campaign discovery.
 *
 * This intentionally duplicates the MCPJungle group admission boundary. A
 * newly-added or renamed group tool remains phase-bounded as an unknown tool
 * until this list is deliberately updated and tested.
 */
const FUSION_CODE_CORE_READ_ONLY_TOOL_NAMES = [
  "smart-tree__overview",
  "smart-tree__find",
  "smart-tree__search",
  "smart-tree__analyze",
  "smart-tree__read",
  "octocode__localSearchCode",
  "octocode__localGetFileContent",
  "octocode__lspGotoDefinition",
  "octocode__lspFindReferences",
  "octocode__lspCallHierarchy",
  "octocode__packageSearch",
  "octocode__githubViewRepoStructure",
  "octocode__githubSearchCode",
  "octocode__githubGetFileContent",
  "semble__search",
  "semble__find_related",
  "context7__resolve-library-id",
  "context7__query-docs",
  "deepwiki__read_wiki_structure",
  "deepwiki__read_wiki_contents",
  "deepwiki__ask_question",
  "brave-search__brave_web_search",
  "brave-search__brave_news_search",
  "brave-search__brave_image_search",
  "serper-mcp__google_search",
  "serper-mcp__google_search_news",
  "serper-mcp__google_search_scholar",
  "fetch-guard__fetch",
] as const;

export const CCC_CAMPAIGN_APPROVED_MCP_DISCOVERY_TOOLS: readonly ApprovedMcpDiscoveryTool[] =
  FUSION_CODE_CORE_READ_ONLY_TOOL_NAMES.map((toolName) => ({
    serverName: FUSION_CODE_CORE_MCP_SERVER_NAME,
    toolName,
  }));
