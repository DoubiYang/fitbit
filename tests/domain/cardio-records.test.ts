import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyHeartRateZone,
  parseActivityLevelInterval,
  parseDailyCardio,
  parseDailyHeartRateZones,
  parseDailyTimeInZone,
  parseExerciseInterval,
  parseHeartRateMinuteAggregate,
  parseMetricResult,
  parseSleepGoal,
  sleepGoalEffectiveCivilDate,
} from '../../src/domain/cardio-records';
import { parseSleepSession } from '../../src/domain/health-records';
import { METRIC_VERSION, WHOOP_STYLE_METRIC_VERSION } from '../../src/domain/metric-types';
import {
  aggregateHeartRateMinutes,
  assignActivityLevel,
  computeStrain,
  isStrainAttributedMinute,
  mergeHeartRateMinuteCoverages,
} from '../../src/domain/whoop-style-metrics';

const userId = 'demo_user';
const sourceFamily = 'google-wearables' as const;

const orderedZones = {
  LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
  MODERATE: { minBeatsPerMinute: 117, maxBeatsPerMinute: 136 },
  VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
  PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
};

const gappedZones = {
  LIGHT: { minBeatsPerMinute: 97, maxBeatsPerMinute: 116 },
  MODERATE: { minBeatsPerMinute: 118, maxBeatsPerMinute: 136 },
  VIGOROUS: { minBeatsPerMinute: 137, maxBeatsPerMinute: 155 },
  PEAK: { minBeatsPerMinute: 156, maxBeatsPerMinute: 200 },
};

function sample(physicalTime: string, beatsPerMinute: number) {
  return { physicalTime, beatsPerMinute, utcOffsetMinutes: 0 };
}

function zonesInput(zones = orderedZones) {
  return {
    userId,
    sourceFamily,
    date: '2026-08-22',
    zones,
  };
}

function minuteInput(
  overrides: Partial<{
    minuteStartUtc: string;
    civilDate: string;
    utcOffsetMinutes: number;
    ianaTimeZone: string | null;
    localMinuteOfDay: number;
    avgBpm: number;
    minBpm: number;
    maxBpm: number;
    sampleCount: number;
    coverageSeconds: number;
    activityLevel: 'SEDENTARY' | 'LIGHTLY_ACTIVE' | 'MODERATELY_ACTIVE' | 'VERY_ACTIVE' | 'unknown';
  }> = {},
) {
  return {
    userId,
    sourceFamily,
    minuteStartUtc: '2026-08-22T12:00:00.000Z',
    civilDate: '2026-08-22',
    utcOffsetMinutes: 0,
    ianaTimeZone: 'UTC',
    localMinuteOfDay: 720,
    avgBpm: 110,
    minBpm: 110,
    maxBpm: 110,
    sampleCount: 8,
    coverageSeconds: 60,
    activityLevel: 'LIGHTLY_ACTIVE' as const,
    ...overrides,
  };
}

test('accepts exactly four ordered Google zones with a 1 bpm gap', () => {
  const parsed = parseDailyHeartRateZones(zonesInput());

  assert.equal(parsed.zones.LIGHT.maxBeatsPerMinute + 1, parsed.zones.MODERATE.minBeatsPerMinute);
  assert.equal(parsed.zones.MODERATE.maxBeatsPerMinute + 1, parsed.zones.VIGOROUS.minBeatsPerMinute);
  assert.equal(parsed.zones.VIGOROUS.maxBeatsPerMinute + 1, parsed.zones.PEAK.minBeatsPerMinute);
  assert.notEqual(parsed.zones.LIGHT.maxBeatsPerMinute, parsed.zones.MODERATE.minBeatsPerMinute);
  assert.equal(METRIC_VERSION, 'p1-v1');
  assert.equal(WHOOP_STYLE_METRIC_VERSION, 'whoop-style-v2');
});

test('classifies every Google zone as an inclusive [min, max] interval', () => {
  const zones = parseDailyHeartRateZones(zonesInput());

  assert.equal(classifyHeartRateZone(97, zones), 'light');
  assert.equal(classifyHeartRateZone(116, zones), 'light');
  assert.equal(classifyHeartRateZone(117, zones), 'moderate');
  assert.equal(classifyHeartRateZone(136, zones), 'moderate');
  assert.equal(classifyHeartRateZone(137, zones), 'vigorous');
  assert.equal(classifyHeartRateZone(155, zones), 'vigorous');
  assert.equal(classifyHeartRateZone(156, zones), 'peak');
  assert.equal(classifyHeartRateZone(200, zones), 'peak');
  assert.equal(classifyHeartRateZone(96, zones), null);
  assert.equal(classifyHeartRateZone(201, zones), null);
});

test('rejects overlapping, incomplete, or inverted zone maps', () => {
  assert.throws(() =>
    parseDailyHeartRateZones(
      zonesInput({
        ...orderedZones,
        MODERATE: { minBeatsPerMinute: 116, maxBeatsPerMinute: 136 },
      }),
    ),
  );
  assert.throws(() =>
    parseDailyHeartRateZones({
      userId,
      sourceFamily,
      date: '2026-08-22',
      zones: {
        LIGHT: orderedZones.LIGHT,
        MODERATE: orderedZones.MODERATE,
        VIGOROUS: orderedZones.VIGOROUS,
      },
    }),
  );
  assert.throws(() =>
    parseDailyHeartRateZones(
      zonesInput({
        ...orderedZones,
        LIGHT: { minBeatsPerMinute: 120, maxBeatsPerMinute: 116 },
      }),
    ),
  );
});

test('sorts newest-first heart-rate pages ascending before holding samples', () => {
  const minutes = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [
      sample('2026-08-22T00:00:20.000Z', 82),
      sample('2026-08-22T00:00:10.000Z', 80),
      sample('2026-08-22T00:00:00.000Z', 78),
    ],
    lookaheadSample: sample('2026-08-22T00:00:40.000Z', 84),
  });

  assert.equal(minutes.length, 1);
  assert.equal(minutes[0]?.minuteStartUtc, '2026-08-22T00:00:00.000Z');
  assert.equal(minutes[0]?.coverageSeconds, 40);
  assert.equal(minutes[0]?.avgBpm, 80.5);
  assert.equal(minutes[0]?.eligible, true);
});

test('holds a sample for at most 75 seconds and splits coverage on minute boundaries', () => {
  const minutes = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:00:50.000Z', 88)],
    lookaheadSample: sample('2026-08-22T00:02:20.000Z', 90),
  });

  const byMinute = new Map(minutes.map((minute) => [minute.minuteStartUtc, minute]));
  assert.equal(byMinute.get('2026-08-22T00:00:00.000Z')?.coverageSeconds, 10);
  assert.equal(byMinute.get('2026-08-22T00:00:00.000Z')?.eligible, false);
  assert.equal(byMinute.get('2026-08-22T00:01:00.000Z')?.coverageSeconds, 60);
  assert.equal(byMinute.get('2026-08-22T00:01:00.000Z')?.eligible, true);
  assert.equal(byMinute.get('2026-08-22T00:02:00.000Z')?.coverageSeconds, 5);
  assert.equal(byMinute.get('2026-08-22T00:02:00.000Z')?.eligible, false);
});

test('page-boundary lookahead neither double-counts nor drops coverage', () => {
  const page1 = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:01:00.000Z', 90), sample('2026-08-22T00:00:30.000Z', 80)],
    lookaheadSample: sample('2026-08-22T00:01:20.000Z', 100),
  });
  const page2 = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:01:20.000Z', 100), sample('2026-08-22T00:01:50.000Z', 110)],
    closeAt: '2026-08-22T00:02:00.000Z',
  });
  const merged = mergeHeartRateMinuteCoverages([page1, page2]);
  const combined = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [
      sample('2026-08-22T00:01:00.000Z', 90),
      sample('2026-08-22T00:00:30.000Z', 80),
      sample('2026-08-22T00:01:20.000Z', 100),
      sample('2026-08-22T00:01:50.000Z', 110),
    ],
    closeAt: '2026-08-22T00:02:00.000Z',
  });

  const mergedMinute = merged.find((minute) => minute.minuteStartUtc === '2026-08-22T00:01:00.000Z');
  const combinedMinute = combined.find((minute) => minute.minuteStartUtc === '2026-08-22T00:01:00.000Z');
  const page1Tail = page1.find((minute) => minute.minuteStartUtc === '2026-08-22T00:01:00.000Z');
  const page2Head = page2.find((minute) => minute.minuteStartUtc === '2026-08-22T00:01:00.000Z');

  assert.equal(page1Tail?.coverageSeconds, 20);
  assert.equal(page2Head?.coverageSeconds, 40);
  assert.equal(mergedMinute?.coverageSeconds, 60);
  assert.equal(combinedMinute?.coverageSeconds, 60);
  assert.equal(mergedMinute?.avgBpm, combinedMinute?.avgBpm);
  assert.equal(merged.find((minute) => minute.minuteStartUtc === '2026-08-22T00:00:00.000Z')?.coverageSeconds, 30);
});

test('page-merge average BPM does not double-weight the same overlapping span', () => {
  const page1 = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:00:00.000Z', 80)],
    lookaheadSample: sample('2026-08-22T00:00:30.000Z', 90),
  });
  const page2 = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:00:00.000Z', 100)],
    lookaheadSample: sample('2026-08-22T00:00:30.000Z', 90),
  });
  const merged = mergeHeartRateMinuteCoverages([page1, page2]);
  const naiveDoubleWeighted = (80 * 30 + 100 * 30) / 60;

  assert.equal(page1[0]?.coverageSeconds, 30);
  assert.equal(page2[0]?.coverageSeconds, 30);
  assert.equal(merged[0]?.coverageSeconds, 30);
  assert.equal(merged[0]?.avgBpm, 80);
  assert.notEqual(merged[0]?.avgBpm, naiveDoubleWeighted);
});

test('a minute is eligible only with at least 30 seconds of coverage', () => {
  const ineligible = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:00:00.000Z', 80)],
    lookaheadSample: sample('2026-08-22T00:00:29.000Z', 81),
  });
  const eligible = aggregateHeartRateMinutes({
    userId,
    sourceFamily,
    samples: [sample('2026-08-22T00:00:00.000Z', 80)],
    lookaheadSample: sample('2026-08-22T00:00:30.000Z', 81),
  });

  assert.equal(ineligible[0]?.coverageSeconds, 29);
  assert.equal(ineligible[0]?.eligible, false);
  assert.equal(eligible[0]?.coverageSeconds, 30);
  assert.equal(eligible[0]?.eligible, true);
});

test('activity-level precedence uses overlap seconds then VERY_ACTIVE > MODERATELY_ACTIVE > LIGHTLY_ACTIVE > SEDENTARY', () => {
  const minuteStartUtc = '2026-08-22T12:00:00.000Z';
  const equalOverlap = assignActivityLevel(minuteStartUtc, [
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:00:30.000Z',
      activityLevelType: 'SEDENTARY',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:30.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'VERY_ACTIVE',
    }),
  ]);
  const longerSedentary = assignActivityLevel(minuteStartUtc, [
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:00:40.000Z',
      activityLevelType: 'SEDENTARY',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:40.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    }),
  ]);
  const threeWayTie = assignActivityLevel(minuteStartUtc, [
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:00:20.000Z',
      activityLevelType: 'SEDENTARY',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:20.000Z',
      endTime: '2026-08-22T12:00:40.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:40.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'MODERATELY_ACTIVE',
    }),
  ]);

  assert.equal(equalOverlap, 'VERY_ACTIVE');
  assert.equal(longerSedentary, 'SEDENTARY');
  assert.equal(threeWayTie, 'MODERATELY_ACTIVE');
});

test('overlapping same-type activity-level intervals union coverage instead of summing', () => {
  const minuteStartUtc = '2026-08-22T12:00:00.000Z';
  const dominant = assignActivityLevel(minuteStartUtc, [
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:00.000Z',
      endTime: '2026-08-22T12:00:20.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:10.000Z',
      endTime: '2026-08-22T12:00:30.000Z',
      activityLevelType: 'LIGHTLY_ACTIVE',
    }),
    parseActivityLevelInterval({
      userId,
      sourceFamily,
      startTime: '2026-08-22T12:00:30.000Z',
      endTime: '2026-08-22T12:01:00.000Z',
      activityLevelType: 'VERY_ACTIVE',
    }),
  ]);

  assert.equal(dominant, 'VERY_ACTIVE');
});

test('sleep overlap excludes LIGHTLY_ACTIVE minutes from Strain unless exercise covers 30 seconds', () => {
  assert.equal(
    isStrainAttributedMinute({
      activityLevel: 'LIGHTLY_ACTIVE',
      sleepOverlapSeconds: 60,
      exerciseOverlapSeconds: 0,
      activeOverlapSeconds: 60,
    }),
    false,
  );
  assert.equal(
    isStrainAttributedMinute({
      activityLevel: 'LIGHTLY_ACTIVE',
      sleepOverlapSeconds: 60,
      exerciseOverlapSeconds: 30,
      activeOverlapSeconds: 60,
    }),
    true,
  );

  const zones = parseDailyHeartRateZones(zonesInput());
  const sleep = parseSleepSession({
    userId,
    source: 'google_health',
    sourceRecordId: 'sleep-1',
    id: 'sleep-1',
    startTime: '2026-08-22T11:30:00.000Z',
    endTime: '2026-08-22T12:30:00.000Z',
    civilEndDate: '2026-08-22',
    utcOffsetMinutes: 0,
    minutesAsleep: 400,
    isNap: true,
    processed: true,
  });
  const sleepingMinute = parseHeartRateMinuteAggregate(minuteInput());
  const excluded = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: [sleepingMinute],
    zones,
    sleepSessions: [sleep],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const withExercise = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: [sleepingMinute],
    zones,
    sleepSessions: [sleep],
    exerciseIntervals: [
      parseExerciseInterval({
        userId,
        sourceFamily,
        sourceRecordId: 'exercise-1',
        startTime: '2026-08-22T12:00:00.000Z',
        endTime: '2026-08-22T12:01:00.000Z',
        utcOffsetMinutes: 0,
        civilDate: '2026-08-22',
      }),
    ],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(excluded.zoneMinutes.light, 0);
  assert.equal(excluded.dose, 0);
  assert.equal(withExercise.zoneMinutes.light, 1);
  assert.ok((withExercise.dose ?? 0) > 0);
});

test('missing activity-level coverage is unknown rather than sedentary rest', () => {
  assert.equal(assignActivityLevel('2026-08-22T12:00:00.000Z', []), 'unknown');
  assert.equal(
    isStrainAttributedMinute({
      activityLevel: 'unknown',
      sleepOverlapSeconds: 0,
      exerciseOverlapSeconds: 0,
      activeOverlapSeconds: 0,
    }),
    false,
  );

  const unknown = parseHeartRateMinuteAggregate(minuteInput({ activityLevel: 'unknown', avgBpm: 70, minBpm: 70, maxBpm: 70 }));
  assert.equal(unknown.activityLevel, 'unknown');
});

test('strain dose requires at least 30 seconds of active overlap, not just a dominant active label', () => {
  assert.equal(
    isStrainAttributedMinute({
      activityLevel: 'LIGHTLY_ACTIVE',
      sleepOverlapSeconds: 0,
      exerciseOverlapSeconds: 0,
      activeOverlapSeconds: 29,
    }),
    false,
  );
  assert.equal(
    isStrainAttributedMinute({
      activityLevel: 'SEDENTARY',
      sleepOverlapSeconds: 0,
      exerciseOverlapSeconds: 0,
      activeOverlapSeconds: 30,
    }),
    true,
  );

  const zones = parseDailyHeartRateZones(zonesInput());
  const labeledActive = parseHeartRateMinuteAggregate(minuteInput({ activityLevel: 'LIGHTLY_ACTIVE' }));
  const shortActive = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: [labeledActive],
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    activityLevelIntervals: [
      parseActivityLevelInterval({
        userId,
        sourceFamily,
        startTime: '2026-08-22T12:00:00.000Z',
        endTime: '2026-08-22T12:00:20.000Z',
        activityLevelType: 'LIGHTLY_ACTIVE',
      }),
      parseActivityLevelInterval({
        userId,
        sourceFamily,
        startTime: '2026-08-22T12:00:20.000Z',
        endTime: '2026-08-22T12:01:00.000Z',
        activityLevelType: 'SEDENTARY',
      }),
    ],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });
  const longActive = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: [labeledActive],
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    activityLevelIntervals: [
      parseActivityLevelInterval({
        userId,
        sourceFamily,
        startTime: '2026-08-22T12:00:00.000Z',
        endTime: '2026-08-22T12:00:30.000Z',
        activityLevelType: 'LIGHTLY_ACTIVE',
      }),
      parseActivityLevelInterval({
        userId,
        sourceFamily,
        startTime: '2026-08-22T12:00:30.000Z',
        endTime: '2026-08-22T12:01:00.000Z',
        activityLevelType: 'SEDENTARY',
      }),
    ],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(shortActive.coverage.attributedMinutes, 0);
  assert.equal(shortActive.coverage.knownContextMinutes, 1);
  assert.equal(shortActive.dose, 0);
  assert.equal(longActive.coverage.attributedMinutes, 1);
  assert.ok((longActive.dose ?? 0) > 0);
});

test('a BPM in a 1 bpm zone gap produces no dose', () => {
  const zones = parseDailyHeartRateZones(zonesInput(gappedZones));
  assert.equal(classifyHeartRateZone(117, zones), null);

  const result = computeStrain({
    userId,
    date: '2026-08-22',
    minutes: [parseHeartRateMinuteAggregate(minuteInput({ avgBpm: 117, minBpm: 117, maxBpm: 117 }))],
    zones,
    sleepSessions: [],
    exerciseIntervals: [],
    timezoneUnambiguous: true,
    isCurrentDay: false,
  });

  assert.equal(result.zoneMinutes.light, 0);
  assert.equal(result.zoneMinutes.moderate, 0);
  assert.equal(result.dose, 0);
});

test('validated cardio records keep sleep-goal T+1 and whoop-style-v2 metric results', () => {
  assert.equal(sleepGoalEffectiveCivilDate('2026-08-20'), '2026-08-21');
  const goal = parseSleepGoal({
    userId,
    goalMinutes: 420,
    effectiveCivilDate: sleepGoalEffectiveCivilDate('2026-08-20'),
  });
  assert.equal(goal.effectiveCivilDate, '2026-08-21');
  assert.throws(() => parseSleepGoal({ userId, goalMinutes: 299, effectiveCivilDate: '2026-08-21' }));
  assert.throws(() => parseSleepGoal({ userId, goalMinutes: 901, effectiveCivilDate: '2026-08-21' }));

  const timeInZone = parseDailyTimeInZone({
    userId,
    sourceFamily,
    date: '2026-08-22',
    minutes: { light: 120, moderate: 30, vigorous: 10, peak: 2 },
  });
  assert.equal(timeInZone.minutes.light, 120);

  const dailyCardio = parseDailyCardio({
    userId,
    date: '2026-08-22',
    status: 'complete',
    strain: 0,
    dose: 0,
    zoneMinutes: { light: 0, moderate: 0, vigorous: 0, peak: 0 },
    knownContextMinutes: 1440,
    rawCoverageMinutes: 1440,
    attributedMinutes: 0,
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
  });
  assert.equal(dailyCardio.status, 'complete');
  assert.equal(dailyCardio.strain, 0);

  const metric = parseMetricResult({
    userId,
    civilDate: '2026-08-22',
    metricName: 'strain',
    metricVersion: WHOOP_STYLE_METRIC_VERSION,
    score: 4.2,
    status: 'provisional',
    quality: null,
    reason: null,
    evidence: [{ label: '剂量', date: '2026-08-22', value: 31 }],
    source: {
      heartRateZones: true,
      activityLevel: true,
      exercise: false,
      sleep: false,
      hrv: false,
      rhr: false,
      sleepGoal: false,
      timeZone: 'unambiguous',
    },
    coverage: {
      knownContextMinutes: 80,
      rawHeartRateMinutes: 80,
      attributedMinutes: 37,
      lastKnownContextAt: '2026-08-22T12:00:00.000Z',
    },
  });
  assert.equal(metric.metricVersion, 'whoop-style-v2');
  assert.equal(metric.status, 'provisional');
  assert.notEqual(metric.status, 'calibrating');
});
