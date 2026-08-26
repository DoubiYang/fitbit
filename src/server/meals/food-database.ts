export type FoodComposition = {
  nameZh: string;
  per100g: {
    energyKcal: number;
    proteinGrams: number;
    carbGrams: number;
    fatGrams: number;
  };
};

const FOODS: FoodComposition[] = [
  { nameZh: '稻米', per100g: { energyKcal: 116, proteinGrams: 2.6, carbGrams: 26, fatGrams: 0.3 } },
  { nameZh: '鸡蛋', per100g: { energyKcal: 144, proteinGrams: 13.1, carbGrams: 1.1, fatGrams: 9.8 } },
  { nameZh: '番茄', per100g: { energyKcal: 18, proteinGrams: 0.9, carbGrams: 3.3, fatGrams: 0.2 } },
  { nameZh: '食用油', per100g: { energyKcal: 884, proteinGrams: 0, carbGrams: 0, fatGrams: 100 } },
];

export function lookupFood(nameZh: string): FoodComposition | undefined {
  return FOODS.find((item) => item.nameZh === nameZh);
}
