const SEASONING = /油|酱油|盐|蒜|姜|葱|芝麻|香草|香菜|酱|醋|糖|调料/;

export function allocateIngredientGrams(ingredients: string[], dishGrams: number): { nameZh: string; grams: number }[] {
  const seasoningGrams: Record<string, number> = {
    油: 8,
    食用油: 8,
    酱油: 10,
    盐: 1,
    蒜: 3,
    芝麻: 2,
    香草: 1,
    香菜: 2,
    调料: 5,
    酱: 12,
  };
  const seasonings = ingredients.filter((name) => SEASONING.test(name));
  const primaries = ingredients.filter((name) => !SEASONING.test(name));
  const allocated = new Map<string, number>();
  let used = 0;
  for (const name of seasonings) {
    const grams = Math.min(seasoningGrams[name] ?? 5, Math.max(1, dishGrams * 0.15));
    allocated.set(name, grams);
    used += grams;
  }
  const remaining = Math.max(dishGrams - used, 0);
  if (primaries.length === 0) {
    return ingredients.map((name) => ({ nameZh: name, grams: allocated.get(name) ?? remaining / ingredients.length }));
  }
  const each = remaining / primaries.length;
  for (const name of primaries) {
    allocated.set(name, each);
  }
  return ingredients.map((name) => ({ nameZh: name, grams: allocated.get(name) ?? 0 }));
}
