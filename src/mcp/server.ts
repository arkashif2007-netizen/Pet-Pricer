/**
 * MCP server.
 *
 * Exposes the scanner as tools so an assistant can answer questions like
 * "which pets are worth crafting right now?" against the local snapshot.
 *
 * Architecture note: MCP is a *layer*, not a data source. This server holds no
 * market logic of its own — it is a thin, read-only projection of the same
 * `ScannerService` the Android app consumes over HTTP. An MCP server with
 * nothing underneath it would return nothing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ScannerService } from '../service.ts';
import type { Verdict } from '../core/types.ts';
import type { Opportunity } from '../core/types.ts';

export interface McpServerOptions {
  name?: string;
  version?: string;
}

const money = (value: number): string =>
  `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;

/** A compact, token-cheap rendering of an opportunity list. */
function renderOpportunities(opportunities: Opportunity[], feePct: number, be: number): string {
  if (opportunities.length === 0) {
    return (
      'No candidates matched. Either the snapshot is empty (run a sweep first) or ' +
      'nothing clears the fee. Note that most pets do NOT: with a ' +
      `${(feePct * 100).toFixed(0)}% sell fee the neon must be worth more than ` +
      `${be.toFixed(2)}x the normal pet just to break even.`
    );
  }

  const lines = opportunities.map((o) => {
    const flag = o.flags.length > 0 ? ` [${[...new Set(o.flags)].join(',')}]` : '';
    return (
      `${o.petName} (${o.petSlug}) | craft ${money(o.craftCost)} = 4 x ${money(o.normalPrice)} ` +
      `(${o.normalAge ?? 'n/a'}) | neon ${money(o.neonPrice)} (${o.neonAge ?? 'n/a'}) ` +
      `-> net ${money(o.neonNet)} | margin ${money(o.margin)} | ratio ${o.ratio.toFixed(2)}x ` +
      `vs break-even ${o.breakEvenRatio.toFixed(2)}x | ${o.verdict}${flag}`
    );
  });

  return [
    `${opportunities.length} candidate(s). Fee ${(feePct * 100).toFixed(0)}%; break-even ratio ${be.toFixed(3)}x.`,
    ...lines,
  ].join('\n');
}

export function createMcpServer(service: ScannerService, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? 'starpets-margin-scanner',
    version: options.version ?? '1.0.0',
  });

  const asText = (text: string, isError = false) => ({
    content: [{ type: 'text' as const, text }],
    isError,
  });

  const requireSnapshot = (): string | null => {
    if (service.status().itemCount === 0) {
      return (
        'The local snapshot is empty, so there is nothing to report. ' +
        'Populate it with `npm run sweep` (one pass) or `npm run watch` (continuous), ' +
        'then call this tool again.'
      );
    }
    return null;
  };

  server.registerTool(
    'market_status',
    {
      title: 'Market snapshot status',
      description:
        'Report the health of the local price snapshot: how many items and pets are known, when the last sweep ran, how stale it is, and the fee/break-even settings in force.',
      inputSchema: {},
    },
    () => {
      const status = service.status();
      const stale = service.isStale() ? ' STALE — run a sweep.' : '';
      return asText(
        [
          `store: ${status.storeUrl}`,
          `snapshot: ${status.itemCount} priced items across ${status.petCount} pets${stale}`,
          `last sweep: ${status.lastSweep ? `#${status.lastSweep.id} ${status.lastSweep.status} ${status.lastSweep.itemsSeen} items in ${status.lastSweep.durationMs ?? 0}ms` : 'never'}`,
          `age: ${status.staleSeconds === null ? 'n/a' : `${status.staleSeconds}s`}`,
          `fee: ${(status.feePct * 100).toFixed(0)}%  break-even ratio: ${status.breakEvenRatio.toFixed(3)}x`,
          `capital cap on the normal input: $${status.maxNormalPrice.toFixed(2)}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'scan_opportunities',
    {
      title: 'Scan for craftable pets',
      description:
        'Rank Adopt Me pets by the margin between four normal pets and one neon. The margin is neon_ask*(1-fee) - 4*normal_ask, so a pet whose neon is under 4/(1-fee) times its normal price is a guaranteed loss. Read-only: this reports prices, it does not buy or trade.',
      inputSchema: {
        max_normal_price: z
          .number()
          .positive()
          .optional()
          .describe('Only consider pets whose cheapest normal input is at most this price (capital cap).'),
        fee_pct: z
          .number()
          .min(0)
          .max(99)
          .optional()
          .describe('Sell-side fee as a percentage, e.g. 25 for 25%. Defaults to the configured value.'),
        verdict: z
          .enum(['craft', 'marginal', 'skip', 'all'])
          .optional()
          .describe('Restrict to one verdict. Defaults to every profitable candidate.'),
        sort_by: z
          .enum(['margin', 'ratio', 'discount'])
          .optional()
          .describe(
            'margin = absolute profit; ratio = margin relative to break-even, the most price-independent ranking; discount = cheapest normal relative to its own 7-day average.'
          ),
        limit: z.number().int().positive().max(500).optional().describe('Maximum rows to return.'),
      },
    },
    (args) => {
      const empty = requireSnapshot();
      if (empty) return asText(empty, true);

      const feePct = args.fee_pct === undefined ? service.defaults.feePct : args.fee_pct / 100;
      const opportunities = service.listOpportunities({
        ...(args.max_normal_price !== undefined ? { maxNormalPrice: args.max_normal_price } : {}),
        feePct,
        ...(args.verdict !== undefined ? { verdict: args.verdict as Verdict | 'all' } : {}),
        ...(args.sort_by !== undefined ? { sortBy: args.sort_by } : {}),
        limit: args.limit ?? 25,
      });

      return asText(renderOpportunities(opportunities, feePct, 4 / (1 - feePct)));
    }
  );

  server.registerTool(
    'get_pet',
    {
      title: 'Explain one pet',
      description:
        'Full breakdown for a single pet: the cheapest normal input and its age, the cheapest neon across every age rung, the margin after fees, the age-ladder gap, and the flags explaining the verdict.',
      inputSchema: {
        pet: z.string().min(1).describe('Pet name or slug, e.g. "Dango Penguins" or "dango_penguins".'),
      },
    },
    ({ pet }) => {
      const empty = requireSnapshot();
      if (empty) return asText(empty, true);

      const resolved = service.resolvePet(pet);
      if (!resolved) {
        const candidates = service.searchPets(pet);
        return asText(
          candidates.length > 0
            ? `"${pet}" is ambiguous. Candidates: ${candidates.map((c) => c.name).join(', ')}`
            : `No pet matching "${pet}" is in the snapshot. Use find_pet to search.`,
          true
        );
      }

      const detail = service.getPet(resolved.slug);
      if (!detail) return asText(`No data for ${resolved.name}.`, true);

      const o = detail.summary;
      return asText(
        [
          `${o.petName} (${o.petSlug}) — ${o.rare ?? 'unknown rarity'}`,
          `verdict: ${o.verdict}`,
          `normal input: ${money(o.normalPrice)} for a ${o.normalAge ?? '?'} pet (product ${o.normalProductId})`,
          `craft cost: 4 x ${money(o.normalPrice)} = ${money(o.craftCost)}`,
          `neon ask: ${money(o.neonPrice)} at ${o.neonAge ?? '?'} (product ${o.neonProductId})`,
          `neon net of ${(o.feePct * 100).toFixed(0)}% fee: ${money(o.neonNet)}`,
          `margin: ${money(o.margin)}  (ratio ${o.ratio.toFixed(2)}x vs break-even ${o.breakEvenRatio.toFixed(2)}x)`,
          `age-ladder gap (full-grown - newborn): ${money(o.tierGap)}`,
          `7-day average ask: normal ${o.normalAvgPrice === null ? 'n/a' : money(o.normalAvgPrice)}, neon ${o.neonAvgPrice === null ? 'n/a' : money(o.neonAvgPrice)}`,
          `neon rungs walked (cheapest first): ${detail.neonLadder.map((r) => `${r.age ?? '?'} ${money(r.price)}`).join(', ') || 'none'}`,
          `variants seen: ${detail.variants.join(', ')}`,
          `flags: ${[...new Set(o.flags)].join(', ') || 'none'}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'get_order_book',
    {
      title: 'Check order-book depth',
      description:
        'Live depth check for one product. A cheap ask with only one offer is not a real opportunity, because a craft consumes four units. This makes a live call to the market, unlike the other tools which read the local snapshot.',
      inputSchema: {
        product_id: z.number().int().positive().optional().describe('Product id, e.g. from get_pet.'),
        pet: z.string().optional().describe('Alternatively, a pet name or slug to resolve first.'),
        units: z.number().int().positive().max(50).optional().describe('Units needed. Defaults to 4.'),
      },
    },
    async ({ product_id, pet, units }) => {
      let productId = product_id;

      if (productId === undefined && pet !== undefined) {
        const resolved = service.resolvePet(pet);
        if (!resolved) return asText(`No pet matching "${pet}" to resolve into a product id.`, true);
        const detail = service.getPet(resolved.slug);
        if (!detail) return asText(`No data for ${resolved.name}.`, true);
        productId = detail.summary.normalProductId;
      }

      if (productId === undefined) {
        return asText('Provide either product_id or pet.', true);
      }

      try {
        const report = await service.orderBook(productId, units ?? 4);
        return asText(
          [
            `product ${report.productId}: ${report.available} offer(s)`,
            `units needed: ${report.units}`,
            `deep enough: ${report.enough ? 'yes' : 'NO — fewer offers than units'}`,
            `cost for ${report.units} units: ${report.costForUnits === null ? 'n/a' : money(report.costForUnits)}`,
            `cheapest: ${report.cheapest === null ? 'n/a' : money(report.cheapest)}`,
            `offers: ${report.offers.slice(0, 12).map((o) => money(o.price)).join(', ')}${report.offers.length > 12 ? ', …' : ''}`,
          ].join('\n')
        );
      } catch (error) {
        return asText(
          `Live lookup failed: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }
    }
  );

  server.registerTool(
    'price_history',
    {
      title: 'Price history for a pet',
      description:
        'Observed asks over time for a pet, for reasoning about drift. Ageing four pets into a neon takes hours to days, so a margin measured once may not survive to the sale.',
      inputSchema: {
        pet: z.string().min(1).describe('Pet name or slug.'),
        hours: z.number().int().positive().max(24 * 14).optional().describe('Lookback window. Defaults to 24 hours.'),
      },
    },
    ({ pet, hours }) => {
      const empty = requireSnapshot();
      if (empty) return asText(empty, true);

      const resolved = service.resolvePet(pet);
      if (!resolved) return asText(`No pet matching "${pet}" in the snapshot.`, true);

      const history = service.history(resolved.slug, hours ?? 24);
      if (!history) return asText(`No history for ${resolved.name}.`, true);

      const summarise = (points: Array<{ ts: number; price: number }>): string => {
        if (points.length === 0) return 'no observations yet';
        const prices = points.map((p) => p.price);
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        const first = points[0] as { price: number };
        const last = points[points.length - 1] as { price: number };
        const drift = first.price > 0 ? (last.price - first.price) / first.price : 0;
        return `${points.length} observations, min ${money(min)}, max ${money(max)}, drift ${(drift * 100).toFixed(1)}%`;
      };

      return asText(
        [
          `${resolved.name} over ${hours ?? 24}h`,
          `normal: ${summarise(history.normal)}`,
          `neon:   ${summarise(history.neon)}`,
        ].join('\n')
      );
    }
  );

  server.registerTool(
    'find_pet',
    {
      title: 'Search the pet catalog',
      description: 'Search the local snapshot for pets by partial name, to discover slugs and exact names.',
      inputSchema: {
        query: z.string().min(1).describe('Partial name, e.g. "penguin".'),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    ({ query, limit }) => {
      const empty = requireSnapshot();
      if (empty) return asText(empty, true);

      const matches = service.searchPets(query, limit ?? 15);
      if (matches.length === 0) return asText(`No pets match "${query}".`);
      return asText(
        `${matches.length} match(es):\n` +
          matches.map((m) => `- ${m.name} (${m.slug}) — ${m.rare ?? 'unknown rarity'}`).join('\n')
      );
    }
  );

  return server;
}
