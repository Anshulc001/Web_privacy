export const CHART_WIDTH = 640;
export const CHART_HEIGHT = 200;
const PADDING = { top: 16, right: 16, bottom: 36, left: 44 };

/**
 * Whole-number tick values from the scale top down to 0, without repeats. A
 * quarter-step scale labelled 1, 1, 1, 0, 0 (or 2, 2, 1, 1, 0) reads like a bug,
 * so small maxima get one tick per unit and larger ones a scale rounded up to a
 * multiple of four.
 */
export function chartTicks(max) {
  const top = Number.isFinite(max) && max > 0 ? Math.max(1, Math.round(max)) : 1;
  if (top < 4) return Array.from({ length: top + 1 }, (_, index) => top - index);
  const scaleMax = Math.ceil(top / 4) * 4;
  return [0, 1, 2, 3, 4].map((step) => scaleMax - (scaleMax / 4) * step).map((value) => Math.round(value));
}

export function niceMax(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value) && value > 0);
  if (list.length === 0) return 1;
  const max = Math.max(...list);
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5]) {
    const candidate = step * magnitude;
    if (max <= candidate) return candidate;
  }
  return 10 * magnitude;
}

/**
 * Computes bar geometry for a column chart. Returns plain numbers so the page can
 * build SVG nodes itself and keep every label out of innerHTML.
 */
export function barChartModel(items, { width = CHART_WIDTH, height = CHART_HEIGHT } = {}) {
  const list = Array.isArray(items) ? items : [];
  const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
  const plotHeight = Math.max(1, height - PADDING.top - PADDING.bottom);
  const ticks = chartTicks(niceMax(list.map((item) => (Number.isFinite(item?.value) ? item.value : 0))));
  const scaleMax = ticks[0];
  const slot = plotWidth / Math.max(1, list.length);
  const barWidth = Math.max(1, Math.min(48, slot * 0.6));

  const bars = list.map((item, index) => {
    const value = Number.isFinite(item?.value) ? item.value : 0;
    const scaled = Math.round((value / scaleMax) * plotHeight);
    return {
      label: String(item?.label ?? ""),
      value,
      x: Math.round(PADDING.left + slot * index + (slot - barWidth) / 2),
      y: Math.round(PADDING.top + plotHeight - scaled),
      width: Math.round(barWidth),
      height: scaled,
      labelX: Math.round(PADDING.left + slot * index + slot / 2),
      labelY: height - PADDING.bottom + 16
    };
  });

  return {
    width,
    height,
    max: scaleMax,
    plot: { x: PADDING.left, y: PADDING.top, width: plotWidth, height: plotHeight },
    axisY: PADDING.top + plotHeight,
    bars,
    // Ticks descend from the scale top, evenly spaced across the plot.
    ticks: ticks.map((value, index) => ({
      value,
      y: Math.round(PADDING.top + (plotHeight * index) / (ticks.length - 1))
    }))
  };
}

/**
 * Geometry for a ranked horizontal bar list. Hostnames are long, so each label
 * gets its own column instead of sitting under a bar where labels collide.
 */
export function horizontalBarModel(items, { width = CHART_WIDTH, labelWidth = 200, rowHeight = 26, padTop = 8, padBottom = 8, padRight = 44 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const height = padTop + padBottom + Math.max(1, list.length) * rowHeight;
  const max = niceMax(list.map((item) => (Number.isFinite(item?.value) ? item.value : 0)));
  const plotWidth = Math.max(1, width - labelWidth - padRight);

  const bars = list.map((item, index) => {
    const value = Number.isFinite(item?.value) ? item.value : 0;
    const center = padTop + index * rowHeight + rowHeight / 2;
    const barHeight = Math.max(6, Math.round(rowHeight * 0.44));
    return {
      label: String(item?.label ?? ""),
      value,
      x: labelWidth,
      y: Math.round(center - barHeight / 2),
      width: value > 0 ? Math.max(2, Math.round((value / max) * plotWidth)) : 0,
      height: barHeight,
      textY: Math.round(center + 4),
      valueX: labelWidth + plotWidth + 8
    };
  });

  return { width, height, max, labelWidth, plotWidth, bars };
}

/** A polyline path for a simple sparkline. */
export function sparklinePath(values, { width = 240, height = 60 } = {}) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (list.length === 0) return "";
  const max = niceMax(list);
  const stepX = list.length > 1 ? width / (list.length - 1) : width;
  return list
    .map((value, index) => {
      const x = Math.round(index * stepX);
      const y = Math.round(height - (value / max) * height);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}
