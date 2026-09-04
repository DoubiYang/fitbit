import type { DailyCardioLoad } from '../../domain/cardio-records';

/**
 * A presentation-safe state for the daily TRIMP panel. It deliberately
 * contains no BPM samples, minute evidence, or raw provider identifiers.
 */
export type CardioLoadTimeline = {
  state: 'verified_load' | 'unverified_elevated_hr' | 'no_verified_load';
  detail: string;
};

export function buildCardioLoadTimeline(input: {
  daily: DailyCardioLoad | undefined;
  isCurrentDay: boolean;
}): CardioLoadTimeline {
  if (input.daily?.dailyLoad !== null && input.daily?.dailyLoad !== undefined && input.daily.qualifiedSeconds > 0) {
    return {
      state: 'verified_load',
      detail: input.isCurrentDay ? '已验证的活动负荷会随当天记录累计。' : '这是完整日中已验证的活动负荷。',
    };
  }
  if ((input.daily?.unverifiedElevatedHrSeconds ?? 0) > 0) {
    return {
      state: 'unverified_elevated_hr',
      detail: '检测到升高心率，但缺少可验证的活动或清醒上下文，未计入 TRIMP。',
    };
  }
  return {
    state: 'no_verified_load',
    detail: input.isCurrentDay ? '今天尚无可验证的活动负荷。' : '没有足够上下文确认当天活动负荷。',
  };
}
