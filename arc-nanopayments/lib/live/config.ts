export type SellerArchetype = "honest" | "faulty" | "absent";

export type SellerConfig = {
  key: "meridian" | "halcyon" | "vantage";
  name: string;
  archetype: SellerArchetype;
  agentId: bigint;
  endpoint: string;
  method: "GET" | "POST";
  price: string;
  service: string;
  description: string;
};

function requiredAgentId(name: string): bigint {
  const value = process.env[name];
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(`${name} must be configured as an ERC-8004 agent id`);
  }
  return BigInt(value);
}

/**
 * Server-only seller catalogue. Agent ids are deployment state and therefore come from
 * environment configuration; client components receive the resolved catalogue only via
 * /api/live/sellers.
 */
export function getSellerConfigs(): SellerConfig[] {
  return [
    {
      key: "meridian",
      name: "Meridian Data",
      archetype: "honest",
      agentId: requiredAgentId("SELLER_MERIDIAN_AGENT_ID"),
      endpoint: "/api/premium/dataset",
      method: "GET",
      price: "$0.01",
      service: "Market pulse dataset",
      description: "Structured market metrics delivered as verified JSON.",
    },
    {
      key: "halcyon",
      name: "Halcyon Compute",
      archetype: "faulty",
      agentId: requiredAgentId("SELLER_HALCYON_AGENT_ID"),
      endpoint: "/api/premium/agent-task",
      method: "GET",
      price: "$0.03",
      service: "Research task",
      description: "A multi-step research result returned over HTTP.",
    },
    {
      key: "vantage",
      name: "Vantage Labs",
      archetype: "absent",
      agentId: requiredAgentId("SELLER_VANTAGE_AGENT_ID"),
      endpoint: "/api/premium/quote",
      method: "GET",
      price: "$0.001",
      service: "Signal quote",
      description: "A lightweight signal lookup from an autonomous endpoint.",
    },
  ];
}

export function getSellerByKey(key: string): SellerConfig | undefined {
  return getSellerConfigs().find((seller) => seller.key === key);
}

export function getSellerForEndpoint(endpoint: string): SellerConfig | undefined {
  return getSellerConfigs().find((seller) => seller.endpoint === endpoint);
}

