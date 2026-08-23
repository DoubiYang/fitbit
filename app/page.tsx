import React from 'react';

export default function Home() {
  return (
    <main className="shell">
      <p className="eyebrow">节律 · P1 演示</p>
      <h1>今日节律</h1>
      <p className="lede">正在准备你的个性化节律视图。</p>
      <section className="notice" aria-labelledby="data-heading">
        <h2 id="data-heading">先连接数据</h2>
        <p>连接健康数据后，这里会显示睡眠、恢复、训练负荷和可追溯的今日建议。</p>
      </section>
    </main>
  );
}
