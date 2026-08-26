import { z } from 'zod';

const portionRangeSchema = z
  .object({
    min: z.number().finite().positive(),
    max: z.number().finite().positive(),
  })
  .refine((value) => value.max >= value.min, { message: 'portion max must be >= min' });

export const visionDishSchema = z.object({
  nameZh: z.string().trim().min(1).max(120),
  ingredients: z.array(z.string().trim().min(1).max(80)).min(1).max(40),
  portionGrams: z.union([portionRangeSchema, z.number().finite().positive()]),
  visibleFraction: z.enum(['full', 'partial', 'unknown']),
  confidence: z.number().finite().min(0).max(1),
  needsConfirmation: z.array(z.string().trim().min(1).max(80)).max(20),
  barcode: z.string().trim().min(1).max(64).nullable().optional(),
  labelText: z.string().trim().min(1).max(4_000).nullable().optional(),
  eatFraction: z.number().finite().gt(0).max(1).optional(),
});

export const visionMealSchema = z.object({
  foods: z.array(visionDishSchema).min(1).max(20),
  photoQuality: z.enum(['usable', 'poor', 'unusable']),
  globalUncertainties: z.array(z.string().trim().min(1).max(200)).max(20),
});

export type VisionDish = z.infer<typeof visionDishSchema>;
export type VisionMeal = z.infer<typeof visionMealSchema>;

export function parseVisionMeal(input: unknown): VisionMeal {
  return visionMealSchema.parse(input);
}

export function isPortionRange(value: VisionDish['portionGrams']): value is { min: number; max: number } {
  return typeof value === 'object';
}
