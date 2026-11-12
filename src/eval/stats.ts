/**
 * 校准用的统计函数。抽出来是为了能用假数据测：CLI 里有 main()，
 * 从测试文件 import 会顺手跑一遍命令行。
 */

/** 皮尔逊相关系数；方差为 0 时返回 null（全是同一个分数，相关性没有意义）。 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2 || n !== ys.length) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? null : sxy / denom;
}

/** 平均秩，处理并列分数。 */
export function ranks(values: number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) result[order[k]!.index] = average;
    i = j + 1;
  }
  return result;
}

export function spearman(xs: number[], ys: number[]): number | null {
  return pearson(ranks(xs), ranks(ys));
}

export function meanAbsoluteError(xs: number[], ys: number[]): number {
  return xs.reduce((sum, x, i) => sum + Math.abs(x - ys[i]!), 0) / Math.max(1, xs.length);
}