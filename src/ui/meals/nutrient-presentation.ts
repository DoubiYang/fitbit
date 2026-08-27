import {
  fromInternalNutrientAmount,
  toInternalNutrientAmount,
  type EditableNutrient,
  type NutritionUnit,
} from '../../domain/meal-editor';
import {
  hasMealAiSuggestionConflict,
  mealAiNutrientUnit,
  type MealAiSuggestion,
} from '../../domain/meal-ai-suggestions';

export type NutrientGroupId = 'energy_and_macros' | 'vitamins' | 'minerals' | 'other_local';

export type MealNutrientPresentationInput = Pick<EditableNutrient, 'dishId' | 'nutrientCode' | 'unit' | 'source'> & {
  /** Missing facts remain unknown; this helper never turns them into zero. */
  value: number | undefined;
};

export type PresentedMealNutrient = {
  dishId: string;
  nutrientCode: string;
  label: string;
  source: EditableNutrient['source'];
  sourceLabel: string;
  displayValue: number | undefined;
  displayUnit: NutritionUnit;
  formattedValue: string;
};

export type NutrientPresentationGroup = {
  id: NutrientGroupId;
  label: string;
  nutrients: PresentedMealNutrient[];
};

type NutrientGroupDefinition = Pick<NutrientPresentationGroup, 'id' | 'label'>;

const GROUPS: readonly NutrientGroupDefinition[] = [
  { id: 'energy_and_macros', label: '能量与宏量' },
  { id: 'vitamins', label: '维生素' },
  { id: 'minerals', label: '矿物质' },
  { id: 'other_local', label: '其他本地已知成分' },
];

const MACRO_NUTRIENTS = new Set([
  'ENERGY',
  'PROTEIN',
  'CARBOHYDRATES',
  'FAT',
  'SATURATED_FAT',
  'TRANS_FAT',
  'MONOUNSATURATED_FAT',
  'POLYUNSATURATED_FAT',
  'UNSATURATED_FAT',
  'SUGAR',
  'ADDED_SUGAR',
  'FREE_SUGAR',
  'DIETARY_FIBER',
  'CHOLESTEROL',
  'CAFFEINE',
]);

const VITAMIN_NUTRIENTS = new Set([
  'BIOTIN',
  'FOLATE',
  'FOLIC_ACID',
  'NIACIN',
  'PANTOTHENIC_ACID',
  'RIBOFLAVIN',
  'THIAMIN',
  'VITAMIN_A',
  'VITAMIN_B12',
  'VITAMIN_B6',
  'VITAMIN_C',
  'VITAMIN_D',
  'VITAMIN_E',
  'VITAMIN_K',
]);

const MINERAL_NUTRIENTS = new Set([
  'CALCIUM',
  'CHLORIDE',
  'CHROMIUM',
  'COPPER',
  'FLUORIDE',
  'IODINE',
  'IRON',
  'MAGNESIUM',
  'MANGANESE',
  'MOLYBDENUM',
  'PHOSPHORUS',
  'POTASSIUM',
  'SELENIUM',
  'SODIUM',
  'ZINC',
]);

const NUTRIENT_LABELS: Readonly<Record<string, string>> = {
  ENERGY: '能量',
  PROTEIN: '蛋白质',
  CARBOHYDRATES: '碳水化合物',
  FAT: '脂肪',
  SATURATED_FAT: '饱和脂肪',
  TRANS_FAT: '反式脂肪',
  MONOUNSATURATED_FAT: '单不饱和脂肪',
  POLYUNSATURATED_FAT: '多不饱和脂肪',
  UNSATURATED_FAT: '不饱和脂肪',
  SUGAR: '糖',
  ADDED_SUGAR: '添加糖',
  FREE_SUGAR: '游离糖',
  DIETARY_FIBER: '膳食纤维',
  CHOLESTEROL: '胆固醇',
  CAFFEINE: '咖啡因',
  VITAMIN_A: '维生素 A',
  VITAMIN_B6: '维生素 B6',
  VITAMIN_B12: '维生素 B12',
  VITAMIN_C: '维生素 C',
  VITAMIN_D: '维生素 D',
  VITAMIN_E: '维生素 E',
  VITAMIN_K: '维生素 K',
  THIAMIN: '维生素 B1',
  RIBOFLAVIN: '维生素 B2',
  NIACIN: '烟酸',
  PANTOTHENIC_ACID: '泛酸',
  FOLATE: '叶酸',
  FOLIC_ACID: '叶酸',
  BIOTIN: '生物素',
  CALCIUM: '钙',
  CHLORIDE: '氯',
  CHROMIUM: '铬',
  COPPER: '铜',
  FLUORIDE: '氟',
  IODINE: '碘',
  IRON: '铁',
  MAGNESIUM: '镁',
  MANGANESE: '锰',
  MOLYBDENUM: '钼',
  PHOSPHORUS: '磷',
  POTASSIUM: '钾',
  SELENIUM: '硒',
  SODIUM: '钠',
  ZINC: '锌',
  OMEGA_3: 'Omega-3 脂肪酸',
  ALA: 'α-亚麻酸',
  EPA: 'EPA',
  DHA: 'DHA',
  CHOLINE: '胆碱',
};

const NUTRIENT_ORDER = new Map([
  ...Object.keys(NUTRIENT_LABELS),
].map((code, index) => [code, index]));

function groupFor(nutrientCode: string): NutrientGroupId {
  if (MACRO_NUTRIENTS.has(nutrientCode)) return 'energy_and_macros';
  if (VITAMIN_NUTRIENTS.has(nutrientCode)) return 'vitamins';
  if (MINERAL_NUTRIENTS.has(nutrientCode)) return 'minerals';
  return 'other_local';
}

export function nutrientLabel(nutrientCode: string): string {
  const mapped = NUTRIENT_LABELS[nutrientCode];
  if (mapped) return mapped;
  if (nutrientCode.startsWith('TW_FDA:')) {
    const officialName = nutrientCode.slice('TW_FDA:'.length).trim();
    return officialName ? `臺灣食藥署：${officialName}` : '臺灣食藥署成分';
  }
  return nutrientCode;
}

function sourceLabel(source: EditableNutrient['source']): string {
  return source === 'user_edit' ? '已手动修改' : '台湾食药署数据';
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 6 }).format(value);
}

/** Avoid exposing IEEE-754 conversion tails (for example 89.39999999999999 mg) in an editor. */
function normaliseDisplayValue(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(12));
}

function displayUnitFor(input: MealNutrientPresentationInput, internal: { value: number; unit: 'g' | 'kcal' }): NutritionUnit {
  if (!input.nutrientCode.startsWith('TW_FDA:') || internal.unit === 'kcal' || internal.value === 0) {
    return mealAiNutrientUnit(input.nutrientCode);
  }
  if (internal.value < 0.001) return 'μg';
  if (internal.value < 1) return 'mg';
  return 'g';
}

function presentNutrient(input: MealNutrientPresentationInput): PresentedMealNutrient {
  const defaultDisplayUnit = mealAiNutrientUnit(input.nutrientCode);
  if (input.value === undefined || !Number.isFinite(input.value) || input.value < 0) {
    return {
      dishId: input.dishId,
      nutrientCode: input.nutrientCode,
      label: nutrientLabel(input.nutrientCode),
      source: input.source,
      sourceLabel: sourceLabel(input.source),
      displayValue: undefined,
      displayUnit: defaultDisplayUnit,
      formattedValue: '未知',
    };
  }
  const internal = toInternalNutrientAmount(input.nutrientCode, input.value, input.unit);
  const displayUnit = displayUnitFor(input, internal);
  const displayed = fromInternalNutrientAmount(input.nutrientCode, internal.value, displayUnit);
  const displayValue = normaliseDisplayValue(displayed.value);
  return {
    dishId: input.dishId,
    nutrientCode: input.nutrientCode,
    label: nutrientLabel(input.nutrientCode),
    source: input.source,
    sourceLabel: sourceLabel(input.source),
    displayValue,
    displayUnit: displayed.unit,
    formattedValue: `${formatNumber(displayValue)} ${displayed.unit}`,
  };
}

function compareNutrients(left: PresentedMealNutrient, right: PresentedMealNutrient): number {
  const byGroupOrder = (NUTRIENT_ORDER.get(left.nutrientCode) ?? Number.MAX_SAFE_INTEGER)
    - (NUTRIENT_ORDER.get(right.nutrientCode) ?? Number.MAX_SAFE_INTEGER);
  if (byGroupOrder !== 0) return byGroupOrder;
  const byCode = left.nutrientCode.localeCompare(right.nutrientCode, 'en');
  return byCode !== 0 ? byCode : left.dishId.localeCompare(right.dishId, 'en');
}

/**
 * Returns every fixed section, while returning only facts supplied by the
 * server. Empty sections therefore never masquerade as zero-valued nutrients.
 */
export function groupMealNutrients(inputs: readonly MealNutrientPresentationInput[]): NutrientPresentationGroup[] {
  const grouped = new Map<NutrientGroupId, PresentedMealNutrient[]>(GROUPS.map((group) => [group.id, []]));
  for (const input of inputs) {
    grouped.get(groupFor(input.nutrientCode))?.push(presentNutrient(input));
  }
  return GROUPS.map((group) => ({
    ...group,
    nutrients: [...(grouped.get(group.id) ?? [])].sort(compareNutrients),
  }));
}

/** ENERGY is energy-only; all other editable nutrient values accept mass units. */
export function editableNutrientUnits(nutrientCode: string): NutritionUnit[] {
  return nutrientCode === 'ENERGY' ? ['kcal'] : ['g', 'mg', 'μg'];
}

export type MealAiApplyAllState =
  | { disabled: false }
  | { disabled: true; reason: 'conflicting_suggestions'; message: string };

export function mealAiApplyAllState(suggestions: readonly MealAiSuggestion[]): MealAiApplyAllState {
  if (!hasMealAiSuggestionConflict([...suggestions])) return { disabled: false };
  return {
    disabled: true,
    reason: 'conflicting_suggestions',
    message: '这批建议会互相覆盖，请逐条应用。',
  };
}

export type NutrientReminderStatus = 'not_eligible' | 'unknown' | 'below_reference' | 'met' | 'above_ul';

export type NutrientReminderPresentationInput = {
  status: NutrientReminderStatus;
  /** Fraction of recorded dish grams whose nutrient value is known. */
  coverage?: number;
};

export type PresentedNutrientReminder = {
  status: NutrientReminderStatus;
  message: string;
};

/**
 * The reminder service is the authority, but presentation retains the same
 * safety gate: insufficient local coverage can never surface as “偏低”.
 */
export function presentNutrientReminder(input: NutrientReminderPresentationInput): PresentedNutrientReminder {
  if (input.status === 'not_eligible') {
    return { status: 'not_eligible', message: '暂无适用的参考摄入量' };
  }
  if (
    input.status === 'unknown'
    || input.coverage === undefined
    || !Number.isFinite(input.coverage)
    || input.coverage < 0.8
    || input.coverage > 1
  ) {
    return { status: 'unknown', message: '数据不足，暂时无法判断' };
  }
  switch (input.status) {
    case 'below_reference':
      return { status: 'below_reference', message: '相对参考摄入量偏低' };
    case 'met':
      return { status: 'met', message: '已达到参考摄入量' };
    case 'above_ul':
      return { status: 'above_ul', message: '相对参考摄入量偏高' };
  }
}
