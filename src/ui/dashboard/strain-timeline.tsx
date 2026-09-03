import type { StrainTimeline as StrainTimelineModel } from '../../server/dashboard/strain-timeline';
import { Moon, Sun, Sunrise } from 'lucide-react';

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

type TimelinePoint = {
  index: number;
  x: number;
  y: number;
  score: number;
};

const PLOT_HEIGHT = 48;
const PLOT_BOTTOM = 43;
const PLOT_TOP = 8;

function pointSegments(timeline: StrainTimelineModel): TimelinePoint[][] {
  const denominator = Math.max(1, timeline.buckets.length - 1);
  const segments: TimelinePoint[][] = [];
  let current: TimelinePoint[] = [];

  timeline.buckets.forEach((bucket, index) => {
    if (bucket.cumulativeScore === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    const point = {
      index,
      x: (index / denominator) * 100,
      y: PLOT_BOTTOM - (Math.min(21, Math.max(0, bucket.cumulativeScore)) / 21) * (PLOT_BOTTOM - PLOT_TOP),
      score: bucket.cumulativeScore,
    };
    current.push(point);
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

function linePath(points: TimelinePoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
}

function gapBridges(segments: TimelinePoint[][]): Array<{ from: TimelinePoint; to: TimelinePoint }> {
  return segments.slice(1).flatMap((segment, index) => {
    const from = segments[index]?.at(-1);
    const to = segment[0];
    return from && to && to.index - from.index > 1 ? [{ from, to }] : [];
  });
}

function areaPath(points: TimelinePoint[]): string {
  if (points.length < 2) return '';
  const start = points[0]!;
  const end = points.at(-1)!;
  return `M ${start.x.toFixed(2)} ${PLOT_BOTTOM} L ${points.map((point) => `${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' L ')} L ${end.x.toFixed(2)} ${PLOT_BOTTOM} Z`;
}

function clockLabel(label: string): string {
  return label.match(/\d{2}:\d{2}$/)?.[0] ?? label;
}

/** Renders only the server-verified Strain score trajectory—never BPM, samples, or forecasts. */
export function StrainTimeline({ timeline }: { timeline: StrainTimelineModel }) {
  const segments = pointSegments(timeline);
  const gaps = gapBridges(segments);
  const lastPoint = segments.at(-1)?.at(-1);
  const middleBucket = timeline.buckets[Math.floor(timeline.buckets.length / 2)];
  const firstBucket = timeline.buckets[0];
  const lastBucket = timeline.buckets.at(-1);

  return (
    <div className="editorial-timeline" aria-label="日内心肺负荷观测">
      <div className="editorial-timeline__plot">
        <div className="editorial-timeline__axis" aria-hidden="true">
          <span>{clockLabel(firstBucket?.label ?? '00:00')}<Sunrise size={17} strokeWidth={1.7} /></span>
          <span>{clockLabel(middleBucket?.label ?? '12:00')}<Sun size={17} strokeWidth={1.7} /></span>
          <span>{clockLabel(lastBucket?.label ?? '24:00')}<Moon size={17} strokeWidth={1.7} /></span>
        </div>
        <svg className="editorial-timeline__curve" viewBox={`0 0 100 ${PLOT_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <line className="editorial-timeline__baseline" x1="0" x2="100" y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} />
          {segments.map((segment) => areaPath(segment) ? <path key={`area-${segment[0]!.index}`} className="editorial-timeline__area" d={areaPath(segment)} /> : null)}
          {segments.map((segment) => segment.length > 1 ? <path key={`line-${segment[0]!.index}`} className="editorial-timeline__line" d={linePath(segment)} /> : null)}
          {gaps.map(({ from, to }) => <path key={`gap-${from.index}-${to.index}`} className="editorial-timeline__gap" d={linePath([from, to])} />)}
          {lastPoint ? <circle className="editorial-timeline__marker" cx={lastPoint.x} cy={lastPoint.y} r="1.65" /> : null}
        </svg>
      </div>
      <p className="editorial-timeline__legend" aria-hidden="true">
        <span><i className="editorial-timeline__legend-line" />当前负荷</span>
        <span><i className="editorial-timeline__legend-observed" />已观测数据</span>
        {gaps.length > 0 ? <span><i className="editorial-timeline__legend-gap" />数据缺口</span> : null}
      </p>
      <ol className="editorial-timeline__a11y">
        {timeline.buckets.map((bucket) => {
          const state = bucketState(bucket);
          return (
            <li
              key={bucket.start}
              aria-label={`${bucket.label}：${state.label}`}
            />
          );
        })}
      </ol>
      <p className="editorial-timeline__observed">观测截至 {timeline.observedThroughLabel}；后续暂无数据。{gaps.length > 0 ? '中间虚线表示数据缺口，未计入负荷。' : null}</p>
    </div>
  );
}
