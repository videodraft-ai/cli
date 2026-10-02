/**
 * Rows for the human `videodraft models` table.
 *
 * The catalog lists models in registry order, which put Veo 3, 3.1 and 2 right under
 * Gemini Omni and Seedance 2.5 eighteenth, with no sign of which models VideoDraft
 * recommends. Agents that read the table instead of `--json` picked from that order.
 * The table now shows each model's tier and lists the recommended (Tier 1) models
 * first, in the catalog's own `recommended` order. `--json` output is unchanged.
 */

type CatalogModel = Record<string, unknown>;

/** A section's `recommended` is an ordered list, or (video) one list per category. */
type Recommended = unknown;

function recommendedIds(
  recommended: Recommended,
  category: string | undefined,
): string[] {
  if (Array.isArray(recommended)) return recommended.map(String);
  if (recommended && typeof recommended === "object" && category) {
    const list = (recommended as Record<string, unknown>)[category];
    if (Array.isArray(list)) return list.map(String);
  }
  return [];
}

function modelId(model: CatalogModel): string {
  return String(model.id ?? model.model_id ?? model.voice_id ?? "");
}

function tierLabel(model: CatalogModel): string {
  return model.tier === 1 || model.tier === 2 ? String(model.tier) : "";
}

/**
 * Recommended models first, in `recommended` order; every other model after them in
 * catalog order. For video the catalog's category grouping is kept, and the order
 * applies within each category. Sections with no tiers (voices, styles) keep their order.
 */
export function orderModelsForTable(
  models: CatalogModel[],
  recommended: Recommended,
  byCategory: boolean,
): CatalogModel[] {
  const categories: string[] = [];
  for (const model of models) {
    const category = byCategory ? String(model.category ?? "") : "";
    if (!categories.includes(category)) categories.push(category);
  }
  return categories.flatMap((category) => {
    const members = models.filter(
      (model) => !byCategory || String(model.category ?? "") === category,
    );
    const ranking = recommendedIds(
      recommended,
      byCategory ? category : undefined,
    );
    const rank = (model: CatalogModel) => {
      const index = ranking.indexOf(modelId(model));
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    };
    // Array.prototype.sort is stable, so unranked models keep their catalog order.
    return [...members].sort((a, b) => rank(a) - rank(b));
  });
}

export interface ModelTable {
  headers: string[];
  rows: string[][];
  hasTiers: boolean;
}

export function modelTable(section: string, payload: unknown): ModelTable {
  const body = (payload ?? {}) as Record<string, unknown>;
  const models = (
    Array.isArray(payload)
      ? payload
      : ((body.models ?? body.voices ?? body.styles ?? []) as unknown[])
  ) as CatalogModel[];
  const hasTiers = models.some((model) => model.tier === 1 || model.tier === 2);
  const ordered = hasTiers
    ? orderModelsForTable(models, body.recommended, section === "video")
    : models;
  const cost = (model: CatalogModel) =>
    String(
      model.credit_cost ??
        model.cost ??
        (model.pricing as Record<string, unknown> | undefined)?.summary ??
        "",
    );
  const name = (model: CatalogModel) => String(model.name ?? "").slice(0, 40);
  if (section === "video") {
    return {
      headers: ["id", "name", "tier", "category", "tool", "cost"],
      rows: ordered.map((model) => [
        modelId(model),
        name(model),
        tierLabel(model),
        String(model.category ?? ""),
        String(model.tool ?? ""),
        cost(model),
      ]),
      hasTiers,
    };
  }
  if (hasTiers) {
    return {
      headers: ["id", "name", "tier", "cost"],
      rows: ordered.map((model) => [
        modelId(model),
        name(model),
        tierLabel(model),
        cost(model),
      ]),
      hasTiers,
    };
  }
  return {
    headers: ["id", "name", "cost"],
    rows: ordered.map((model) => [modelId(model), name(model), cost(model)]),
    hasTiers,
  };
}

/** Printed once under a tiered table, in human mode only. */
export const TIER_NOTE =
  "Tier 1 is recommended and listed first. Use a Tier 2 model only when the user names it or no Tier 1 model supports the request.";
