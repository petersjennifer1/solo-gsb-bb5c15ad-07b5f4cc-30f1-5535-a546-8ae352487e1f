/*
 * 仿射拟合（浏览器 / Node 通用模块）
 *
 * 给定 n ≥ 3 对控制点 (x_i, y_i) → (u_i, v_i)，求解六参数仿射变换：
 *     u = a·x + b·y + c
 *     v = d·x + e·y + f
 *
 * 提供两种模式：
 *  1) fitAffine 经典最小二乘：使全部控制点残差平方和最小。
 *  2) fitAffineRobust 稳健模式：按固定顺序枚举有上限的非共线三点候选
 *     （三点恰好确定一个仿射模型），以「内点数量优先、内点平方误差次之」
 *     选出最佳候选，再对全部内点重新做最小二乘拟合，并迭代重分类至稳定。
 *     内点判定基于参考图像素容差 tolerancePx；外点不参与最终 RMSE。
 *     枚举上限保证点对增多时计算量有界，拖动不卡顿。
 *
 * 数值实现：最小二乘先对源点与目标点分别中心化，正规方程退化为两个
 * 2×2 线性方程组（平移量由质心回代），避免大坐标下的数值病态。
 *
 * 近共线判定：点集协方差矩阵的最小/最大特征值之比小于
 * COLLINEAR_RATIO 时视为近共线（含全部重合），拒绝拟合。
 *
 * 留出验证：两种拟合的结果均附带 validation 字段（leaveOneOutValidation），
 * 对每个参与拟合的点，移除后用其余参与点重新最小二乘拟合，再预测该留出点
 * 的目标位置并计算误差；参与点不足 4 个或留出后点集近共线时该点标记
 * 「无法验证」，汇总仅统计可验证点。稳健模式的参与集为最终内点，外点不参与。
 *
 * RGBA 像素变换（transformRGBA，可独立调用）：将源 RGBA 像素数组按拟合矩阵
 * （源 → 输出坐标系）变换到指定尺寸的输出画布。对每个输出像素，其像素中心
 * (i+0.5, j+0.5) 经逆仿射映射回源图连续坐标取样，以四邻像素做双线性插值；
 * 越界邻点视为透明黑；颜色先乘 alpha 再插值、输出时还原，alpha 为零时
 * RGB 归零；各通道四舍五入到 0~255。矩阵含非有限值或线性部分行列式绝对值
 * ≤ MIN_MATRIX_DET（1e-12）时拒绝（checkExportMatrix / invertMatrix）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Affine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN_POINTS = 3;
  // 近共线阈值：λmin/λmax < 1e-4，即点集垂直方向展宽不足主方向的 1%
  const COLLINEAR_RATIO = 1e-4;
  // 稳健模式：枚举三点候选（及扫描三元组）的上限，保证计算量有界
  const MAX_CANDIDATES = 256;
  // 稳健模式：内点重拟合后重新分类的最大迭代次数（实测通常 1~2 次即稳定）
  const MAX_REFINE_ITERS = 16;
  // 稳健模式默认参考图像素容差
  const DEFAULT_TOLERANCE_PX = 2;
  // 像素变换/导出可用性的矩阵阈值：线性部分行列式 |a·e − b·d| 下限
  const MIN_MATRIX_DET = 1e-12;

  class FitError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'FitError';
      this.code = code;
    }
  }

  function centroid(points) {
    let sx = 0, sy = 0;
    for (const p of points) { sx += p.x; sy += p.y; }
    return { x: sx / points.length, y: sy / points.length };
  }

  /**
   * 评估点集共线程度。
   * @returns {{degenerate: boolean, ratio: number}} ratio 为 λmin/λmax
   */
  function collinearity(points) {
    const c = centroid(points);
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of points) {
      const dx = p.x - c.x, dy = p.y - c.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const trace = sxx + syy;
    if (trace <= 0) return { degenerate: true, ratio: 0 }; // 所有点重合
    let det = sxx * syy - sxy * sxy;
    if (det < 0) det = 0; // 浮点误差兜底
    const disc = Math.sqrt(Math.max(trace * trace - 4 * det, 0));
    const lMax = (trace + disc) / 2;
    const lMin = (trace - disc) / 2;
    const ratio = lMax > 0 ? lMin / lMax : 0;
    return { degenerate: ratio < COLLINEAR_RATIO, ratio };
  }

  function validate(src, dst) {
    if (!Array.isArray(src) || !Array.isArray(dst) || src.length !== dst.length) {
      throw new FitError('BAD_INPUT', '源点与目标点必须为等长数组');
    }
    if (src.length < MIN_POINTS) {
      throw new FitError('TOO_FEW_POINTS', `至少需要 ${MIN_POINTS} 对控制点`);
    }
    for (const p of src.concat(dst)) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new FitError('BAD_INPUT', '控制点坐标必须为有限数字');
      }
    }
  }

  /**
   * 最小二乘求解（不做校验）：调用方需保证至少 3 对点且两侧均非共线。
   */
  function solveAffine(src, dst) {
    const n = src.length;
    const cs = centroid(src), cd = centroid(dst);
    let sxx = 0, sxy = 0, syy = 0, sxu = 0, syu = 0, sxv = 0, syv = 0;
    for (let i = 0; i < n; i++) {
      const dx = src[i].x - cs.x, dy = src[i].y - cs.y;
      const du = dst[i].x - cd.x, dv = dst[i].y - cd.y;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
      sxu += dx * du; syu += dy * du;
      sxv += dx * dv; syv += dy * dv;
    }
    const D = sxx * syy - sxy * sxy; // 非共线检查已保证 D > 0

    const a = (sxu * syy - syu * sxy) / D;
    const b = (syu * sxx - sxu * sxy) / D;
    const d = (sxv * syy - syv * sxy) / D;
    const e = (syv * sxx - sxv * sxy) / D;
    const c = cd.x - a * cs.x - b * cs.y;
    const f = cd.y - d * cs.x - e * cs.y;
    return { a, b, c, d, e, f };
  }

  function residualsOf(matrix, src, dst) {
    return src.map((p, i) => {
      const u = matrix.a * p.x + matrix.b * p.y + matrix.c;
      const v = matrix.d * p.x + matrix.e * p.y + matrix.f;
      return Math.hypot(u - dst[i].x, v - dst[i].y);
    });
  }

  /**
   * 仿射最小二乘拟合（经典模式，使用全部控制点）。
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @returns {{matrix:{a,b,c,d,e,f}, residuals:number[], rmse:number, maxIndex:number, pointCount:number, inliers:boolean[], validation:object}}
   *          validation 为逐点留出验证结果（见 leaveOneOutValidation）
   * @throws {FitError} code ∈ TOO_FEW_POINTS | COLLINEAR_SRC | COLLINEAR_DST | BAD_INPUT
   */
  function fitAffine(src, dst) {
    validate(src, dst);
    const n = src.length;

    if (collinearity(src).degenerate) {
      throw new FitError('COLLINEAR_SRC', '扫描图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }
    if (collinearity(dst).degenerate) {
      throw new FitError('COLLINEAR_DST', '参考图控制点过于接近共线（或重合），无法求解仿射变换，请调整点位分布');
    }

    const matrix = solveAffine(src, dst);
    const residuals = residualsOf(matrix, src, dst);
    const rmse = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n);
    let maxIndex = 0;
    residuals.forEach((r, i) => { if (r > residuals[maxIndex]) maxIndex = i; });

    return {
      matrix,
      residuals,
      rmse,
      maxIndex,
      pointCount: n,
      inliers: new Array(n).fill(true),
      validation: leaveOneOutValidation(src, dst, null)
    };
  }

  /**
   * 稳健仿射拟合（RANSAC-lite）。
   *
   * 按 (i,j,k) 字典序枚举至多 maxCandidates 个三元组，仅评估两侧均非共线
   * 的候选；以三点精确解作为候选模型，统计参考图像素容差内的内点：
   *   内点数更多者胜；内点数相同则内点平方误差和更小者胜（首个最优点保留）。
   * 选定模型后，对内点重新做最小二乘拟合，并按新模型重新分类，迭代至
   * 内点集合稳定。最终残差对所有点给出，RMSE 仅统计内点。
   *
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @param {{tolerancePx?:number, maxCandidates?:number, maxIterations?:number}} [options]
   * @returns {{matrix, residuals:number[], rmse:number, maxIndex:number, pointCount:number,
   *            inliers:boolean[], inlierCount:number, outlierCount:number,
   *            tolerancePx:number, candidatesEvaluated:number, inlierSse:number,
   *            refined:boolean, validation:object}}
   *          validation 为逐点留出验证结果（仅内点参与，外点 excluded）
   * @throws {FitError} code ∈ TOO_FEW_POINTS | BAD_INPUT |
   *                    NO_NONCOLLINEAR_TRIPLET | NO_NONCOLLINEAR_INLIERS
   */
  function fitAffineRobust(src, dst, options) {
    validate(src, dst);
    const n = src.length;
    const opts = options || {};
    const maxCandidates = Math.max(1, Math.floor(opts.maxCandidates || MAX_CANDIDATES));
    const maxIterations = Math.max(1, Math.floor(opts.maxIterations || MAX_REFINE_ITERS));
    const tolerancePx = opts.tolerancePx === undefined ? DEFAULT_TOLERANCE_PX : opts.tolerancePx;
    if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
      throw new FitError('BAD_INPUT', '参考图像素容差必须为不小于 0 的有限数字');
    }
    // 与坐标尺度相关的浮点容差（tol=0 时三点自身仍可判为内点）
    let scaleMax = 1;
    for (const p of dst) {
      const m = Math.max(Math.abs(p.x), Math.abs(p.y));
      if (m > scaleMax) scaleMax = m;
    }
    const eps = 1e-9 * scaleMax;
    const isInlier = (r) => r <= tolerancePx + eps;

    // ---- 有上限地枚举非共线三点候选（固定字典序，保证结果可复现）----
    let best = null; // { matrix, inliers:boolean[], count, sse }
    let evaluated = 0;
    let scanned = 0;
    let triSrcDegenerate = false;
    let triDstDegenerate = false;
    let hitScanLimit = false;

    outer:
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        for (let k = j + 1; k < n; k++) {
          if (scanned >= maxCandidates) { hitScanLimit = true; break outer; }
          scanned++;
          const s3 = [src[i], src[j], src[k]];
          const d3 = [dst[i], dst[j], dst[k]];
          if (collinearity(s3).degenerate) { triSrcDegenerate = true; continue; }
          if (collinearity(d3).degenerate) { triDstDegenerate = true; continue; }

          const matrix = solveAffine(s3, d3);
          const residuals = residualsOf(matrix, src, dst);
          const inliers = new Array(n).fill(false);
          let count = 0, sse = 0;
          for (let t = 0; t < n; t++) {
            if (isInlier(residuals[t])) { inliers[t] = true; count++; sse += residuals[t] * residuals[t]; }
          }
          evaluated++;
          // 内点数量优先、内点平方误差次之；枚举按固定顺序，平局保留首个
          if (!best || count > best.count || (count === best.count && sse < best.sse)) {
            best = { matrix, inliers, count, sse };
          }
        }
      }
    }

    if (!best) {
      let message;
      if (!hitScanLimit) {
        message = triSrcDegenerate && !triDstDegenerate
          ? '扫描图中找不到三对非共线控制点，无法求解仿射变换，请调整点位分布'
          : triDstDegenerate && !triSrcDegenerate
            ? '参考图中找不到三对非共线控制点，无法求解仿射变换，请调整点位分布'
            : '找不到三对非共线控制点（点位重合或近共线），无法求解仿射变换，请调整点位分布';
      } else {
        message = '已评估的控制点三元组均近共线或重合，找不到可用的非共线三点，请调整点位分布';
      }
      throw new FitError('NO_NONCOLLINEAR_TRIPLET', message);
    }

    // ---- 对内点重新最小二乘拟合，并迭代重分类至稳定 ----
    let inliers = best.inliers;
    let matrix = best.matrix;
    let refined = false;
    for (let iter = 0; iter < maxIterations; iter++) {
      const idx = [];
      for (let t = 0; t < n; t++) if (inliers[t]) idx.push(t);
      const inSrc = idx.map((t) => src[t]);
      const inDst = idx.map((t) => dst[t]);
      if (idx.length >= MIN_POINTS &&
          !collinearity(inSrc).degenerate && !collinearity(inDst).degenerate) {
        matrix = solveAffine(inSrc, inDst);
        refined = true;
      }
      // 否则保留上一步的模型（best 至少含 3 个非共线内点）

      const residuals = residualsOf(matrix, src, dst);
      const next = new Array(n).fill(false);
      let changed = false;
      for (let t = 0; t < n; t++) {
        next[t] = isInlier(residuals[t]);
        if (next[t] !== inliers[t]) changed = true;
      }
      inliers = next;
      if (!changed) break;
    }

    const inlierIdx = [];
    for (let t = 0; t < n; t++) if (inliers[t]) inlierIdx.push(t);
    if (inlierIdx.length < MIN_POINTS) {
      // 正常不会发生（容差只增不减时内点只会更稳定），保留点对并禁用导出
      throw new FitError('NO_NONCOLLINEAR_INLIERS', '容差内的非共线内点不足 3 对，无法得到稳健模型，请放宽像素容差或调整点位');
    }
    if (collinearity(inlierIdx.map((t) => src[t])).degenerate ||
        collinearity(inlierIdx.map((t) => dst[t])).degenerate) {
      throw new FitError('NO_NONCOLLINEAR_INLIERS', '容差内的内点近共线（或重合），无法求解仿射变换，请放宽像素容差或调整点位分布');
    }

    // ---- 最终模型与统计（RMSE 仅统计内点；maxIndex 为内点中残差最大者）----
    const residuals = residualsOf(matrix, src, dst);
    let sse = 0, maxIndex = -1;
    for (const t of inlierIdx) {
      sse += residuals[t] * residuals[t];
      if (maxIndex === -1 || residuals[t] > residuals[maxIndex]) maxIndex = t;
    }
    const rmse = Math.sqrt(sse / inlierIdx.length);

    return {
      matrix,
      residuals,
      rmse,
      maxIndex,
      pointCount: n,
      inliers,
      inlierCount: inlierIdx.length,
      outlierCount: n - inlierIdx.length,
      tolerancePx,
      candidatesEvaluated: evaluated,
      inlierSse: sse,
      refined,
      validation: leaveOneOutValidation(src, dst, inliers)
    };
  }

  /**
   * 逐点留出验证（leave-one-out）。
   *
   * 对每个参与拟合的点 i：将其移除，用其余参与点重新做最小二乘仿射拟合，
   * 再预测留出点的目标位置并计算误差（目标坐标系的像素距离）。
   * 参与点不足 4 个（留出后不足 3 个）或某次留出后的点集近共线时，该点
   * 标记为「无法验证」（error 为 null，绝不用原拟合残差充数）；汇总仅统计
   * 可验证点的 RMSE / 最大误差，零个可验证点时汇总字段为 null（不可用）。
   *
   * @param {Array<{x:number,y:number}>} src 源点（扫描图）
   * @param {Array<{x:number,y:number}>} dst 目标点（参考图）
   * @param {boolean[]|null} [inliers] 参与拟合的点；缺省表示全部参与。
   *        稳健模式传入最终内点数组，外点状态为 'excluded'（不参与）。
   * @returns {{points:Array<{index:number,participates:boolean,status:string,error:number|null}>,
   *            participantCount:number, verifiableCount:number,
   *            rmse:number|null, maxError:number|null, maxIndex:number}}
   *          status ∈ 'ok' | 'unverifiable' | 'excluded'
   */
  function leaveOneOutValidation(src, dst, inliers) {
    const n = src.length;
    const participates = inliers ? inliers.map(Boolean) : new Array(n).fill(true);
    const participantCount = participates.reduce((s, v) => s + (v ? 1 : 0), 0);
    const enough = participantCount >= MIN_POINTS + 1; // 留出后仍需 ≥3 个参与点

    const points = [];
    let sse = 0, verifiableCount = 0, maxError = -1, maxIndex = -1;
    for (let i = 0; i < n; i++) {
      if (!participates[i]) {
        points.push({ index: i, participates: false, status: 'excluded', error: null });
        continue;
      }
      if (!enough) {
        points.push({ index: i, participates: true, status: 'unverifiable', error: null });
        continue;
      }
      const s2 = [], d2 = [];
      for (let j = 0; j < n; j++) {
        if (j !== i && participates[j]) { s2.push(src[j]); d2.push(dst[j]); }
      }
      // 留出后任一侧近共线（或重合）则无法可靠重拟合，该点无法验证
      if (collinearity(s2).degenerate || collinearity(d2).degenerate) {
        points.push({ index: i, participates: true, status: 'unverifiable', error: null });
        continue;
      }
      const m = solveAffine(s2, d2);
      const pred = applyMatrix(m, src[i]);
      const err = Math.hypot(pred.x - dst[i].x, pred.y - dst[i].y);
      points.push({ index: i, participates: true, status: 'ok', error: err });
      sse += err * err;
      verifiableCount++;
      if (err > maxError) { maxError = err; maxIndex = i; }
    }

    return {
      points,
      participantCount,
      verifiableCount,
      rmse: verifiableCount > 0 ? Math.sqrt(sse / verifiableCount) : null,
      maxError: verifiableCount > 0 ? maxError : null,
      maxIndex
    };
  }

  /** 对单个点应用六参数矩阵 */
  function applyMatrix(m, p) {
    return { x: m.a * p.x + m.b * p.y + m.c, y: m.d * p.x + m.e * p.y + m.f };
  }

  /**
   * 校验矩阵是否可用于像素变换/导出：六参数均为有限值，且线性部分
   * 行列式 |a·e − b·d| > MIN_MATRIX_DET（1e-12），否则不可逆。
   * @param {{a,b,c,d,e,f}} m
   * @returns {{ok:true, det:number} | {ok:false, reason:string}} reason 为中文原因
   */
  function checkExportMatrix(m) {
    if (!m) return { ok: false, reason: '拟合矩阵缺失' };
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
      if (!Number.isFinite(m[k])) {
        return { ok: false, reason: '拟合矩阵含非有限值，无法求逆做像素变换' };
      }
    }
    const det = m.a * m.e - m.b * m.d;
    if (!Number.isFinite(det) || Math.abs(det) <= MIN_MATRIX_DET) {
      return { ok: false, reason: '拟合矩阵线性部分行列式绝对值 ≤ 1e-12，不可逆，无法做像素变换' };
    }
    return { ok: true, det };
  }

  /**
   * 求六参数仿射矩阵的逆（先经 checkExportMatrix 校验）。
   * 正向 u = a·x + b·y + c，v = d·x + e·y + f 的逆映射为：
   *   x = ( e·(u−c) − b·(v−f)) / det
   *   y = (−d·(u−c) + a·(v−f)) / det
   * @throws {FitError} code = BAD_MATRIX（非有限值或行列式绝对值 ≤ 1e-12）
   */
  function invertMatrix(m) {
    const chk = checkExportMatrix(m);
    if (!chk.ok) throw new FitError('BAD_MATRIX', chk.reason);
    const det = chk.det;
    return {
      a: m.e / det,
      b: -m.b / det,
      c: (m.b * m.f - m.e * m.c) / det,
      d: -m.d / det,
      e: m.a / det,
      f: (m.d * m.c - m.a * m.f) / det
    };
  }

  /** 通道四舍五入并钳制到 0~255 */
  function clampRound(v) {
    const r = Math.round(v);
    return r < 0 ? 0 : r > 255 ? 255 : r;
  }

  /**
   * RGBA 像素变换（可独立调用，纯像素计算，不依赖 DOM/Canvas）。
   *
   * 将源 RGBA 像素数组按拟合矩阵 matrix（源 → 输出坐标系）重采样到
   * outW × outH 的输出画布：对每个输出像素 (i, j)，取其像素中心
   * (i+0.5, j+0.5)，经逆仿射映射回源图连续坐标，以四邻像素做双线性插值
   * （源像素中心同样位于 (x+0.5, y+0.5)）。规则：
   *   - 越界邻点视为透明黑 (0,0,0,0)，不参与贡献；
   *   - 颜色先乘 alpha（预乘）再插值，输出时除以插值后的 alpha 还原；
   *   - 插值后 alpha 为零时 RGB 归零；
   *   - 各通道四舍五入到 0~255。
   *
   * @param {Uint8Array|Uint8ClampedArray} srcData 源 RGBA 数据（长度 srcW·srcH·4）
   * @param {number} srcW 源图宽（正整数）
   * @param {number} srcH 源图高（正整数）
   * @param {{a,b,c,d,e,f}} matrix 正向仿射矩阵（源 → 输出坐标系）
   * @param {number} outW 输出宽（正整数）
   * @param {number} outH 输出高（正整数）
   * @returns {Uint8ClampedArray} 输出 RGBA 数据（长度 outW·outH·4）
   * @throws {FitError} code ∈ BAD_INPUT | BAD_MATRIX
   */
  function transformRGBA(srcData, srcW, srcH, matrix, outW, outH) {
    if (!srcData || !Number.isInteger(srcW) || !Number.isInteger(srcH) ||
        srcW <= 0 || srcH <= 0 || srcData.length !== srcW * srcH * 4) {
      throw new FitError('BAD_INPUT', '源像素数据缺失或长度与源图宽高不符');
    }
    if (!Number.isInteger(outW) || !Number.isInteger(outH) || outW <= 0 || outH <= 0) {
      throw new FitError('BAD_INPUT', '输出宽高必须为正整数');
    }
    const inv = invertMatrix(matrix); // 含非有限值 / 行列式校验

    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let j = 0; j < outH; j++) {
      // 输出像素中心 (i+0.5, j+0.5) 经逆仿射映射回源图连续坐标
      const baseX = inv.b * (j + 0.5) + inv.c;
      const baseY = inv.e * (j + 0.5) + inv.f;
      for (let i = 0; i < outW; i++) {
        const sx = inv.a * (i + 0.5) + baseX;
        const sy = inv.d * (i + 0.5) + baseY;
        // 源像素中心位于 (x+0.5, y+0.5)：换算到像素索引空间取四邻
        const fx = sx - 0.5, fy = sy - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        // 双线性插值（颜色预乘 alpha；越界邻点为透明黑，不贡献）
        let r = 0, g = 0, b = 0, alpha = 0;
        for (let dy = 0; dy <= 1; dy++) {
          const yy = y0 + dy;
          const wy = dy === 0 ? 1 - ty : ty;
          if (wy === 0) continue;
          for (let dx = 0; dx <= 1; dx++) {
            const xx = x0 + dx;
            const w = wy * (dx === 0 ? 1 - tx : tx);
            if (w === 0) continue;
            if (xx < 0 || xx >= srcW || yy < 0 || yy >= srcH) continue; // 透明黑
            const idx = (yy * srcW + xx) * 4;
            const sa = srcData[idx + 3] / 255;
            r += w * srcData[idx] * sa;
            g += w * srcData[idx + 1] * sa;
            b += w * srcData[idx + 2] * sa;
            alpha += w * srcData[idx + 3];
          }
        }
        const o = (j * outW + i) * 4;
        if (alpha <= 0) {
          // alpha 为零时 RGB 归零（透明黑）
          out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
        } else {
          // 输出时还原预乘：除以插值后的 alpha
          const sa = alpha / 255;
          out[o] = clampRound(r / sa);
          out[o + 1] = clampRound(g / sa);
          out[o + 2] = clampRound(b / sa);
          out[o + 3] = clampRound(alpha);
        }
      }
    }
    return out;
  }

  return {
    fitAffine,
    fitAffineRobust,
    leaveOneOutValidation,
    applyMatrix,
    collinearity,
    checkExportMatrix,
    invertMatrix,
    transformRGBA,
    FitError,
    MIN_POINTS,
    COLLINEAR_RATIO,
    MAX_CANDIDATES,
    MAX_REFINE_ITERS,
    DEFAULT_TOLERANCE_PX,
    MIN_MATRIX_DET
  };
});
