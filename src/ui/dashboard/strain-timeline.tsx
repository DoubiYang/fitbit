import type { StrainTimeline as StrainTimelineModel } from '../../server/dashboard/strain-timeline';

function bucketState(bucket: StrainTimelineModel['buckets'][number]): {
  label: string;
  state: 'unobserved' | 'unknown-context' | 'unattributed' | 'exercise-attributed' | 'intensity-0' | 'intensity-1' | 'intensity-2' | 'intensity-3';
  intensity: 0 | 1 | 2 | 3 | null;
} {
  if (bucket.observedHeartRateMinutes === 0) return { label: '未观测', state: 'unobserved', intensity: null };
  if (bucket.attributedMinutes > bucket.knownContextMinutes) {
    return {
      label: bucket.intensity === null ? '运动归因（活动上下文未知）' : `运动归因 · ${intensityLabel(bucket.intensity)}（活动上下文未知）`,
      state: 'exercise-attributed',
      intensity: bucket.intensity,
    };
  }
  if (bucket.knownContextMinutes === 0) return { label: '上下文未知', state: 'unknown-context', intensity: null };
  if (bucket.attributedMinutes === 0 || bucket.intensity === null) return { label: '未归因', state: 'unattributed', intensity: null };
  if (bucket.intensity === 0) return { label: '低强度', state: 'intensity-0', intensity: 0 };
  if (bucket.intensity === 1) return { label: '轻度', state: 'intensity-1', intensity: 1 };
  if (bucket.intensity === 2) return { label: '中等强度', state: 'intensity-2', intensity: 2 };
  return { label: '高强度', state: 'intensity-3', intensity: 3 };
}

function intensityLabel(intensity: 0 | 1 | 2 | 3): string {
  if (intensity === 0) return '低强度';
  if (intensity === 1) return '轻度';
  if (intensity === 2) return '中等强度';
  return '高强度';
}

/** Renders only the server-verified, coarse intensity projection—never BPM or samples. */
export function StrainTimeline({ timeline }: { timeline: StrainTimelineModel }) {
  return (
    <div className="editorial-timeline" aria-label="日内心肺负荷观测">
      <ol className="editorial-timeline__buckets">
        {timeline.buckets.map((bucket) => {
          const state = bucketState(bucket);
          return (
            <li
              key={bucket.start}
              className="editorial-timeline__bucket"
              data-observation={state.state}
              data-intensity={state.intensity ?? 'unknown'}
              aria-label={`${bucket.label}：${state.label}`}
            />
          );
        })}
      </ol>
      <p className="editorial-timeline__caption">
        <span className="editorial-timeline__start">{timeline.buckets[0]?.label ?? '开始'}</span>
        <span className="editorial-timeline__center">日内观测</span>
        <span className="editorial-timeline__end">{timeline.buckets.at(-1)?.label ?? '结束'}</span>
      </p>
      <p className="editorial-timeline__observed">观测截至 {timeline.observedThroughLabel}；后续暂无数据。</p>
    </div>
  );
}
