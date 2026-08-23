import type { MetricEvidence } from '../../domain/metric-types';

export function EvidenceList({ evidence }: { evidence: MetricEvidence[] }) {
  if (evidence.length === 0) {
    return null;
  }

  return (
    <ol className="evidence-list" aria-label="建议依据">
      {evidence.map((item) => (
        <li key={`${item.label}-${item.date}`}>
          {item.label} · {item.date}：{item.value}
        </li>
      ))}
    </ol>
  );
}

export function DataState({ text, evidence }: { text: string; evidence: MetricEvidence[] }) {
  return (
    <section className="data-state" aria-labelledby="data-state-heading">
      <h3 id="data-state-heading">数据状态</h3>
      <p>{text}</p>
      <EvidenceList evidence={evidence} />
    </section>
  );
}
