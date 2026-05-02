// tools/definitions.js — Tool schemas (OpenAI function calling format)
// Adopted from Meridian tools/definitions.js pattern
// Agent calls these tools to actively explore the market

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "screen_pools",
      description: "Screen all Meteora DLMM pools and return top candidates based on TVL, volume, fee ratio, and organic score. Use this to discover which markets are active and worth monitoring for arbitrage.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of pools to return (default 20, max 50)",
          },
          min_tvl: {
            type: "number",
            description: "Minimum TVL in USD (default 5000)",
          },
          sort_by: {
            type: "string",
            enum: ["volume", "fee", "tvl"],
            description: "Sort pools by this metric",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pool_price",
      description: "Get the current active bin price and pool metadata for a specific Meteora DLMM pool address. Use this to check if a pool has a price discrepancy vs another pool for the same token pair.",
      parameters: {
        type: "object",
        properties: {
          pool_address: {
            type: "string",
            description: "The Solana address of the Meteora DLMM pool",
          },
        },
        required: ["pool_address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "simulate_route",
      description: "Simulate an arbitrage route by fetching real Jupiter quotes for each hop. Returns expected profit, ROI, and price impact. Use this to evaluate any route you discover before recommending execution.",
      parameters: {
        type: "object",
        properties: {
          tokens: {
            type: "array",
            items: { type: "string" },
            description: "Token symbols or mint addresses in order, e.g. ['USDC', 'ANB', 'USDC'] or full mint addresses",
          },
          input_amount_usdc: {
            type: "number",
            description: "USDC amount to simulate with (default 0.2)",
          },
        },
        required: ["tokens"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_token_info",
      description: "Get token metadata: holder count, market cap, 24h volume, organic score, and launchpad info. Use this to assess whether a token is legitimate or potentially a rug/manipulated pool.",
      parameters: {
        type: "object",
        properties: {
          mint_address: {
            type: "string",
            description: "The SPL token mint address",
          },
        },
        required: ["mint_address"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_wallet_status",
      description: "Get current wallet SOL and USDC balance. Use this to check available capital before recommending execution.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_execution_history",
      description: "Get recent arbitrage execution history: wins, losses, profit per route. Use this to learn which routes have been profitable and which have failed.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of recent executions to return (default 10)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_pool_prices",
      description: "Compare prices of the same token across multiple pools (DAMM v2 vs DLMM vs Orca etc) to detect price discrepancies. This is the core arbitrage signal — if price on pool A is much higher than pool B, an arb opportunity exists.",
      parameters: {
        type: "object",
        properties: {
          token_mint: {
            type: "string",
            description: "The mint address of the token to compare",
          },
          pool_addresses: {
            type: "array",
            items: { type: "string" },
            description: "List of pool addresses to compare prices across",
          },
        },
        required: ["token_mint", "pool_addresses"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_arb",
      description: "Execute an arbitrage route. Only call this when you have verified profitability via simulate_route and assessed token safety via get_token_info. Requires high confidence.",
      parameters: {
        type: "object",
        properties: {
          tokens: {
            type: "array",
            items: { type: "string" },
            description: "Token route to execute, e.g. ['USDC', 'ANB', 'USDC']",
          },
          input_amount_usdc: {
            type: "number",
            description: "USDC to use (default: value from config)",
          },
          reason: {
            type: "string",
            description: "Brief explanation of why you are executing this route",
          },
        },
        required: ["tokens", "reason"],
      },
    },
  },
];

export default TOOL_DEFINITIONS;
