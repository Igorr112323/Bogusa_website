/** Мини-графики на чистом SVG/DOM — без внешних библиотек и без innerHTML. */

import { el, fmtShortDate } from './api.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Столбики распределения оценок 1..5.
 * @param {{1:number,2:number,3:number,4:number,5:number}} distribution
 * @param {number} total
 */
export function distributionBars(distribution, total) {
  const values = [1, 2, 3, 4, 5].map((score) => Number(distribution?.[score] || 0));
  const max = Math.max(...values, 1);
  const percent = total ? Math.round((values.reduce((a, b) => a + b, 0) / total) * 100) : 0;

  const bars = values.map((count, index) => {
    const score = index + 1;
    const height = Math.max(3, Math.round((count / max) * 100));
    return el('div', {
      class: 'dist-bar',
      title: `Оценка ${score}: ${count}`,
      attrs: { 'aria-label': `Оценка ${score}: ${count}` },
      dataset: { score: String(score) },
      style: { height: `${height}%` },
    });
  });

  return el('div', { class: 'bar-line' }, [
    el('div', { class: 'dist', attrs: { role: 'img', 'aria-label': `Распределение оценок, заполнено ${percent}%` } }, bars),
    el('span', { class: 'tiny muted mono', text: `n=${total ?? values.reduce((a, b) => a + b, 0)}` }),
  ]);
}

/**
 * Линейный график: столбцы — число ответов, линия — средний балл.
 * @param {Array<{date:string, responses:number, avg:number}>} points
 */
export function timelineChart(points) {
  if (!points || points.length === 0) {
    return el('div', { class: 'empty', text: 'Пока нет данных для графика' });
  }

  const width = 720;
  const height = 180;
  const padding = { top: 14, right: 34, bottom: 26, left: 30 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const maxResponses = Math.max(...points.map((p) => p.responses), 1);
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;
  const barWidth = Math.max(3, Math.min(22, innerW / points.length - 3));

  const root = svg('svg', {
    class: 'chart',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Динамика ответов: ${points.length} точек, всего ${points.reduce((a, p) => a + p.responses, 0)} анкет`,
  });

  // Сетка
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (innerH / 4) * i;
    root.append(svg('line', { x1: padding.left, y1: y, x2: width - padding.right, y2: y, stroke: 'currentColor', 'stroke-opacity': '0.12' }));
  }

  // Столбцы: количество ответов
  points.forEach((point, index) => {
    const value = point.responses;
    const barH = Math.max(2, (value / maxResponses) * innerH);
    const x = padding.left + index * step - barWidth / 2;
    root.append(
      svg('rect', {
        x: Math.max(padding.left, x),
        y: padding.top + innerH - barH,
        width: barWidth,
        height: barH,
        rx: 2,
        fill: '#b9c8da',
      })
    );
  });

  // Линия среднего балла (шкала 1..5)
  const avgY = (avg) => padding.top + innerH - ((Math.max(1, Math.min(5, avg)) - 1) / 4) * innerH;
  const pathData = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${(padding.left + index * step).toFixed(1)} ${avgY(point.avg).toFixed(1)}`)
    .join(' ');

  root.append(svg('path', { d: pathData, fill: 'none', stroke: '#2f4f70', 'stroke-width': '2.5', 'stroke-linejoin': 'round' }));
  points.forEach((point, index) => {
    root.append(
      svg('circle', {
        cx: padding.left + index * step,
        cy: avgY(point.avg),
        r: 3,
        fill: '#2f4f70',
      })
    );
  });

  // Подписи по оси X (не больше 6 штук)
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((point, index) => {
    if (index % labelStep !== 0 && index !== points.length - 1) return;
    const text = svg('text', {
      x: padding.left + index * step,
      y: height - 8,
      'text-anchor': 'middle',
      'font-size': '11',
      fill: 'currentColor',
      'fill-opacity': '0.65',
    });
    text.textContent = fmtShortDate(point.date);
    root.append(text);
  });

  // Подписи по оси Y (средний балл)
  [1, 3, 5].forEach((score) => {
    const text = svg('text', {
      x: width - padding.right + 6,
      y: avgY(score) + 4,
      'font-size': '11',
      fill: 'currentColor',
      'fill-opacity': '0.65',
    });
    text.textContent = String(score);
    root.append(text);
  });

  return el('div', {}, [
    root,
    el('div', { class: 'chart-legend' }, [
      el('span', {}, [el('i', { class: 'legend-dot brand' }), 'средний балл (1–5)']),
      el('span', {}, [el('i', { class: 'legend-dot', style: { background: '#b9c8da' } }), 'количество анкет за день']),
    ]),
  ]);
}

/** Компактная полоса «доля положительных ответов» 0..100%. */
export function positiveBar(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  return el('div', { class: 'bar-line' }, [
    el('div', { class: 'bar-track', attrs: { role: 'img', 'aria-label': `${value}% ответов 4 и 5` } }, [
      el('div', { class: 'bar-fill', style: { width: `${value}%` } }),
    ]),
    el('span', { class: 'tiny mono muted', text: `${value}%` }),
  ]);
}
