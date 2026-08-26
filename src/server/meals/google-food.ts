const API_ROOT = 'https://health.googleapis.com/v4';

export type GoogleFoodHit = {
  name: string;
  displayName: string;
  energyKcal: number | undefined;
  carbGrams: number | undefined;
  fatGrams: number | undefined;
  proteinGrams: number | undefined;
  servingGrams: number | undefined;
  nutrients: Record<string, number>;
};

export type FoodSearchAttempt = {
  kind: string;
  status: number;
  hitCount: number;
  sampleNames: string[];
  error: string | undefined;
};

export type GoogleFoodCatalog = {
  search(query: string): Promise<GoogleFoodHit[]>;
};

type FoodServing = {
  amount?: number;
  foodMeasurementUnitDisplayName?: string;
  multiplier?: number;
};

type FoodPayload = {
  name?: string;
  food?: {
    displayName?: string;
    energyAvg?: { kcal?: number };
    energy?: { kcal?: number };
    energyFromFat?: { kcal?: number };
    totalCarbohydrate?: { grams?: number };
    totalFat?: { grams?: number };
    nutrients?: Array<{ nutrient?: string; quantity?: { grams?: number } }>;
    defaultServing?: FoodServing;
    servings?: FoodServing[];
  };
};

function isGramUnit(name: string | undefined): boolean {
  const unit = (name ?? '').trim().toLowerCase();
  return unit === '克' || unit === '公克' || unit === 'g' || unit === 'gram' || unit === 'grams' || unit.includes('gram');
}

function gramsInUnitName(name: string | undefined): number | undefined {
  const match = (name ?? '').match(/（\s*(\d+(?:\.\d+)?)\s*克\s*）|\(\s*(\d+(?:\.\d+)?)\s*g(?:rams?)?\s*\)/i);
  if (!match) {
    return undefined;
  }
  return Number(match[1] ?? match[2]);
}

function servingGrams(food: NonNullable<FoodPayload['food']>): number | undefined {
  const serving = food.defaultServing;
  if (!serving || serving.amount === undefined) {
    return 100;
  }
  if (isGramUnit(serving.foodMeasurementUnitDisplayName)) {
    return serving.amount;
  }
  const defaultMultiplier = serving.multiplier && serving.multiplier > 0 ? serving.multiplier : 1;
  const namedGrams = gramsInUnitName(serving.foodMeasurementUnitDisplayName);
  if (namedGrams !== undefined) {
    return namedGrams * serving.amount;
  }
  const candidates = food.servings ?? [];
  for (const candidate of candidates) {
    if (candidate.amount === undefined || !candidate.multiplier) {
      continue;
    }
    if (isGramUnit(candidate.foodMeasurementUnitDisplayName)) {
      return candidate.amount * (defaultMultiplier / candidate.multiplier);
    }
    const candidateGrams = gramsInUnitName(candidate.foodMeasurementUnitDisplayName);
    if (candidateGrams !== undefined && Math.abs(candidate.multiplier - defaultMultiplier) < 1e-6) {
      return candidateGrams;
    }
  }
  const unit = serving.foodMeasurementUnitDisplayName ?? '';
  if (unit.includes('汤匙') || unit.includes('餐匙') || unit.toLowerCase().includes('tablespoon')) {
    return 15 * serving.amount;
  }
  if (unit.includes('茶匙') || unit.toLowerCase().includes('teaspoon')) {
    return 5 * serving.amount;
  }
  return 100;
}

function nutrientGrams(food: NonNullable<FoodPayload['food']>, code: string): number | undefined {
  return food.nutrients?.find((item) => (item.nutrient ?? '').toUpperCase() === code)?.quantity?.grams;
}

export function catalogNutrients(food: NonNullable<FoodPayload['food']>): Record<string, number> {
  const nutrients: Record<string, number> = {};
  for (const item of food.nutrients ?? []) {
    const code = (item.nutrient ?? '').toUpperCase();
    const grams = item.quantity?.grams;
    if (!code || code === 'NUTRIENT_UNSPECIFIED' || grams === undefined) {
      continue;
    }
    nutrients[code] = grams;
  }
  return nutrients;
}

export function mapFoodHit(point: FoodPayload): GoogleFoodHit | undefined {
  const food = point.food;
  if (!food?.displayName) {
    return undefined;
  }
  const nutrients = catalogNutrients(food);
  return {
    name: point.name ?? '',
    displayName: food.displayName,
    energyKcal: food.energyAvg?.kcal ?? food.energy?.kcal,
    carbGrams: food.totalCarbohydrate?.grams ?? nutrients.CARBOHYDRATES,
    fatGrams: food.totalFat?.grams,
    proteinGrams: nutrients.PROTEIN,
    servingGrams: servingGrams(food),
    nutrients,
  };
}

const DISPLAY_MG = new Set([
  'SODIUM',
  'POTASSIUM',
  'CALCIUM',
  'MAGNESIUM',
  'PHOSPHORUS',
  'CHLORIDE',
  'CHOLESTEROL',
  'IRON',
  'ZINC',
  'COPPER',
  'MANGANESE',
  'VITAMIN_C',
  'VITAMIN_E',
  'VITAMIN_B6',
  'NIACIN',
  'PANTOTHENIC_ACID',
  'THIAMIN',
  'RIBOFLAVIN',
]);

const DISPLAY_UG = new Set([
  'VITAMIN_A',
  'VITAMIN_D',
  'VITAMIN_K',
  'VITAMIN_B12',
  'FOLATE',
  'FOLIC_ACID',
  'SELENIUM',
  'IODINE',
  'CHROMIUM',
  'MOLYBDENUM',
  'BIOTIN',
]);

export function formatNutrientGrams(code: string, grams: number): { amount: number; unit: 'g' | 'mg' | 'µg' } {
  if (DISPLAY_UG.has(code)) {
    return { amount: grams * 1_000_000, unit: 'µg' };
  }
  if (DISPLAY_MG.has(code)) {
    return { amount: grams * 1_000, unit: 'mg' };
  }
  return { amount: grams, unit: 'g' };
}

export function displayNutrients(nutrients: Record<string, number>): Record<string, string> {
  const displayed: Record<string, string> = {};
  for (const code of Object.keys(nutrients).sort()) {
    const { amount, unit } = formatNutrientGrams(code, nutrients[code] ?? 0);
    const rounded = unit === 'g' ? amount.toFixed(2) : amount.toFixed(1);
    displayed[code] = `${rounded} ${unit}`;
  }
  return displayed;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((part) => part.length > 0);
}

function hasCjk(value: string): boolean {
  return /[\u4e00-\u9fff]/.test(value);
}

function boundedContains(name: string, needle: string): boolean {
  if (name === needle) {
    return true;
  }
  if (hasCjk(needle) && needle.length <= 2) {
    return (
      name.startsWith(`${needle} `) ||
      name.startsWith(`${needle},`) ||
      name.startsWith(`${needle}，`) ||
      name.startsWith(`${needle}、`) ||
      name.startsWith(`${needle}（`) ||
      name.startsWith(`${needle}(`)
    );
  }
  return name.startsWith(needle) || name.includes(needle);
}

export function pickBestHit(query: string, hits: GoogleFoodHit[]): GoogleFoodHit | undefined {
  const needle = query.trim().toLowerCase();
  if (hits.length === 0 || !needle) {
    return undefined;
  }
  const scored = hits.map((hit) => {
    const name = hit.displayName.toLowerCase();
    const words = tokens(hit.displayName);
    let score = 0;
    if (name === needle) {
      score += 100;
    }
    if (words.includes(needle)) {
      score += 50;
    }
    if (boundedContains(name, needle) && name !== needle) {
      score += name.startsWith(needle) ? 30 : 20;
    }
    if (/\bcooked\b|\bstir[- ]fried\b|\broasted\b|\bbraised\b/.test(name)) {
      score += 8;
    }
    if (/\bbroth\b|\bsoup\b|\bgravy\b|\bsauce\b|\broll\b|\bbread\b|\bcake\b|\bjuice\b|\bcandy\b/.test(name) && !/\b(sauce|roll|bread|cake|juice)\b/.test(needle)) {
      score -= 40;
    }
    if (/酸奶|口味|优格|yogurt|ice cream|布丁/.test(name)) {
      score -= 50;
    }
    if (/\braw\b/.test(name)) {
      score -= 4;
    }
    if (hit.servingGrams) {
      score += 1;
    }
    score -= Math.min(name.length, 80) / 100;
    return { hit, score };
  });
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < 50) {
    return undefined;
  }
  return best.hit;
}

function quoteFilterValue(query: string): string {
  return query.replaceAll('"', '').trim();
}

async function listFoods(input: {
  accessToken: string;
  pageSize: number;
  filter?: string;
  query?: string;
}): Promise<{ status: number; hits: GoogleFoodHit[]; error: string | undefined; sampleNames: string[] }> {
  const params = new URLSearchParams({ pageSize: String(input.pageSize) });
  if (input.filter) {
    params.set('filter', input.filter);
  }
  if (input.query) {
    params.set('query', input.query);
  }
  const url = `${API_ROOT}/users/me/dataTypes/food/dataPoints?${params.toString()}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.accessToken}`, Accept: 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) {
    return {
      status: response.status,
      hits: [],
      error: text.slice(0, 400),
      sampleNames: [],
    };
  }
  const body = JSON.parse(text) as { dataPoints?: FoodPayload[] };
  const hits = (body.dataPoints ?? []).flatMap((point) => {
    const mapped = mapFoodHit(point);
    return mapped ? [mapped] : [];
  });
  return {
    status: response.status,
    hits,
    error: undefined,
    sampleNames: hits.slice(0, 5).map((hit) => hit.displayName),
  };
}

export async function probeFoodSearch(accessToken: string, query: string): Promise<FoodSearchAttempt[]> {
  const safe = quoteFilterValue(query);
  const attempts: Array<{ kind: string; filter?: string; query?: string }> = [
    { kind: 'unfiltered' },
    { kind: 'displayName=', filter: `food.displayName = "${safe}"` },
    { kind: 'display_name=', filter: `food.display_name = "${safe}"` },
    { kind: 'displayName:', filter: `food.displayName : "${safe}"` },
    { kind: 'display_name:', filter: `food.display_name : "${safe}"` },
    { kind: 'displayName*', filter: `food.displayName = "${safe}*"` },
    { kind: 'query-param', query: safe },
  ];
  const results: FoodSearchAttempt[] = [];
  for (const attempt of attempts) {
    const listed = await listFoods({
      accessToken,
      pageSize: attempt.kind === 'unfiltered' ? 5 : 10,
      filter: attempt.filter,
      query: attempt.query,
    });
    results.push({
      kind: attempt.kind,
      status: listed.status,
      hitCount: listed.hits.length,
      sampleNames: listed.sampleNames,
      error: listed.error,
    });
    if (listed.status === 401 || listed.status === 403) {
      break;
    }
  }
  return results;
}

export function createGoogleFoodCatalog(accessToken: string): GoogleFoodCatalog {
  const cache = new Map<string, GoogleFoodHit[]>();
  return {
    async search(query: string): Promise<GoogleFoodHit[]> {
      const key = query.trim().toLowerCase();
      const cached = cache.get(key);
      if (cached) {
        return cached;
      }
      const safe = quoteFilterValue(query);
      if (!safe) {
        cache.set(key, []);
        return [];
      }
      const attempts: Array<{ filter?: string; query?: string }> = [
        { filter: `food.display_name = "${safe}"` },
      ];
      for (const attempt of attempts) {
        const listed = await listFoods({ accessToken, pageSize: 25, ...attempt });
        if (listed.status === 401 || listed.status === 403) {
          throw new Error(`food catalog ${listed.status}`);
        }
        if (listed.hits.length > 0) {
          cache.set(key, listed.hits);
          return listed.hits;
        }
      }
      cache.set(key, []);
      return [];
    },
  };
}
