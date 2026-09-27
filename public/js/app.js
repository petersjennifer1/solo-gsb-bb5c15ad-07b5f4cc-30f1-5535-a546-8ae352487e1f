/* global Affine */
/*
 * 前端主逻辑：
 *  - 上传参考图 / 扫描图（FileReader 本地读取，不上传服务器）
 *  - 两图成对点击标注控制点（任意一图先点均可，自动配对）
 *  - 拖动微调、右键删除、列表删除；任何变化立即重算仿射拟合
 *  - 可切换「稳健模式」：按参考图像素容差以内点数量优先枚举三点候选，
 *    再对内点重新最小二乘拟合；外点在双图标记与残差表中区分显示，
 *    不计入 RMSE。容差调整、点位编辑/删除均同步重算。
 *  - 叠加预览与两种 JSON 导出共用同一最终矩阵，导出记录内/外点身份
 *  - 「导出校准扫描图」：用点击时的扫描图与最终拟合矩阵（两种模式均可），
 *    经 Affine.transformRGBA 逆仿射重采样（四邻双线性插值、预乘 alpha、
 *    越界透明黑），下载与参考图原始宽高一致、仅含变换后扫描图的 PNG；
 *    图像缺失 / 拟合无效 / 矩阵含非有限值 / 行列式 |det| ≤ 1e-12 时禁用并说明原因。
 *    像素处理全部在浏览器本地完成，图像不上传服务器。
 *  - 残差实时列表，内点最大残差橙色高亮、外点红色标识；近共线拒绝并提示
 *  - 逐点留出验证（复用 affine.js 的 leaveOneOutValidation，与 /api/fit 输出一致）：
 *    残差表「留出验证」列显示每个参与点的留出误差；参与点不足 4 个或留出后
 *    点集近共线显示「无法验证」，稳健模式外点显示「不参与」；状态栏与拟合面板
 *    汇总可验证点的 RMSE / 最大误差（零个可验证点时显示不可用），最差点橙色标出。
 *    点位增删/拖动、模式与容差变化均实时重算。
 */
(function () {
  'use strict';

  // ---------- 状态 ----------
  const state = {
    refImg: null,            // 参考图 HTMLImageElement
    scanImg: null,           // 扫描图 HTMLImageElement
    points: [],              // 已完成配对 {id, ref:{x,y}, scan:{x,y}}
    pending: { ref: null, scan: null }, // 进行中的半对点
    nextId: 1,
    fit: null,               // 拟合结果（含 matrix/residuals/inliers 等）
    fitError: null,          // 近共线等错误提示（中文）
    robust: false,           // 是否启用稳健模式
    tolerancePx: Affine.DEFAULT_TOLERANCE_PX, // 稳健模式参考图像素容差
    dragging: null,          // {id, which:'ref'|'scan'}
    opacity: 0.5
  };

  const HIT_RADIUS_CSS = 12;   // 命中半径（CSS 像素）
  const COLOR_INLIER = '#22c55e';   // 内点：绿
  const COLOR_OUTLIER = '#ef4444';  // 外点：红（虚线）
  const COLOR_MAX = '#f59e0b';      // 内点中最大残差：橙
  const COLOR_PENDING = '#eab308';

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const refCanvas = $('refCanvas');
  const scanCanvas = $('scanCanvas');
  const overlayCanvas = $('overlayCanvas');
  const statusEl = $('status');
  const fitPanelEl = $('fitPanel');
  const ptTableBody = $('ptTable').querySelector('tbody');
  const ptCountEl = $('ptCount');
  const opacityInput = $('opacity');
  const opacityVal = $('opacityVal');
  const btnExportMatrix = $('btnExportMatrix');
  const btnExportResiduals = $('btnExportResiduals');
  const btnExportImage = $('btnExportImage');
  const exportImgHint = $('exportImgHint');
  const btnClear = $('btnClear');
  const robustModeInput = $('robustMode');
  const toleranceInput = $('tolerance');
  const tolLabel = $('tolLabel');

  // ---------- 图像加载 ----------
  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('无法解析图像文件'));
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(input, which) {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const img = await loadImageFromFile(file);
      if (which === 'ref') state.refImg = img; else state.scanImg = img;
      clearPoints(); // 图像更换后旧坐标失效，清空控制点
    } catch (err) {
      setStatus(err.message, 'error');
    }
  }

  // ---------- 坐标换算 ----------
  function eventToCanvas(canvas, e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (canvas.width / r.width),
      y: (e.clientY - r.top) * (canvas.height / r.height)
    };
  }

  // CSS 像素 → 画布像素的缩放系数（保证标记视觉大小一致）
  function canvasScale(canvas) {
    const r = canvas.getBoundingClientRect();
    return r.width > 0 ? canvas.width / r.width : 1;
  }

  // ---------- 拟合 ----------
  // 判断第 i 对控制点是否为内点（经典模式下所有点都是内点）
  function isInlier(i) {
    return !state.fit || !state.fit.inliers || state.fit.inliers[i];
  }

  function recompute() {
    state.fit = null;
    state.fitError = null;
    if (state.points.length >= Affine.MIN_POINTS) {
      try {
        const src = state.points.map((p) => p.scan); // 源：扫描图
        const dst = state.points.map((p) => p.ref);  // 目标：参考图
        state.fit = state.robust
          ? Affine.fitAffineRobust(src, dst, { tolerancePx: state.tolerancePx })
          : Affine.fitAffine(src, dst);
      } catch (err) {
        state.fitError = err.message || String(err);
      }
    }
    render();
  }

  // ---------- 控制点操作 ----------
  function clearPoints() {
    state.points = [];
    state.pending = { ref: null, scan: null };
    state.dragging = null;
    recompute();
  }

  function deletePoint(id) {
    state.points = state.points.filter((p) => p.id !== id);
    recompute();
  }

  function hitTest(canvas, which, pos) {
    const tol = HIT_RADIUS_CSS * canvasScale(canvas);
    // 后添加的点优先命中（视觉上在上层）
    for (let i = state.points.length - 1; i >= 0; i--) {
      const q = state.points[i][which];
      if (Math.hypot(q.x - pos.x, q.y - pos.y) <= tol) return state.points[i];
    }
    return null;
  }

  function placePoint(which, pos) {
    state.pending[which] = pos;
    if (state.pending.ref && state.pending.scan) {
      state.points.push({
        id: state.nextId++,
        ref: state.pending.ref,
        scan: state.pending.scan
      });
      state.pending = { ref: null, scan: null };
      recompute();
    } else {
      render();
    }
  }

  // ---------- 画布事件 ----------
  function bindCanvas(canvas, which) {
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        state.dragging = { id: hit.id, which };
        e.preventDefault();
      } else {
        placePoint(which, pos);
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!state.dragging || state.dragging.which !== which) return;
      const pos = eventToCanvas(canvas, e);
      const pt = state.points.find((p) => p.id === state.dragging.id);
      if (!pt) return;
      pt[which] = {
        x: Math.min(Math.max(pos.x, 0), canvas.width),
        y: Math.min(Math.max(pos.y, 0), canvas.height)
      };
      recompute(); // 拖动中实时重算
    });

    window.addEventListener('mouseup', () => { state.dragging = null; });

    canvas.addEventListener('contextmenu', (e) => {
      const img = which === 'ref' ? state.refImg : state.scanImg;
      if (!img) return;
      const pos = eventToCanvas(canvas, e);
      const hit = hitTest(canvas, which, pos);
      if (hit) {
        e.preventDefault();
        deletePoint(hit.id);
      }
    });
  }

  // ---------- 绘制 ----------
  function drawPlaceholder(canvas, text) {
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '20px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function drawMarker(ctx, p, label, color, scale, opts) {
    opts = opts || {};
    const r = 9 * scale;
    ctx.save();
    ctx.lineWidth = 2 * scale;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (opts.dashed) ctx.setLineDash([4 * scale, 3 * scale]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // 内点最大残差：额外一圈橙色高亮环
    if (opts.ring) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 4 * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 中心十字
    ctx.beginPath();
    ctx.moveTo(p.x - r * 0.55, p.y); ctx.lineTo(p.x + r * 0.55, p.y);
    ctx.moveTo(p.x, p.y - r * 0.55); ctx.lineTo(p.x, p.y + r * 0.55);
    ctx.stroke();
    // 序号标签
    ctx.font = `bold ${12 * scale}px system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3 * scale;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.fillText(label, p.x + r + 2 * scale, p.y - 2 * scale);
    ctx.restore();
  }

  // 第 i 对点的标记样式：外点红色虚线；内点中最大残差橙色加环；其余绿色
  function markerStyle(i) {
    const f = state.fit;
    if (f && f.inliers && !f.inliers[i]) {
      return { color: COLOR_OUTLIER, dashed: true, ring: false };
    }
    if (f && i === f.maxIndex) {
      return { color: COLOR_MAX, dashed: false, ring: true };
    }
    return { color: COLOR_INLIER, dashed: false, ring: false };
  }

  function drawImageCanvas(canvas, img, which) {
    if (!img) {
      drawPlaceholder(canvas, which === 'ref' ? '请先上传参考图' : '请先上传扫描图');
      return;
    }
    if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
    }
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const scale = canvasScale(canvas);

    state.points.forEach((pt, i) => {
      const s = markerStyle(i);
      drawMarker(ctx, pt[which], String(i + 1), s.color, scale, { dashed: s.dashed, ring: s.ring });
    });
    const pending = state.pending[which];
    if (pending) drawMarker(ctx, pending, '?', COLOR_PENDING, scale, { dashed: true });
  }

  function drawOverlay() {
    if (!state.refImg) {
      drawPlaceholder(overlayCanvas, '上传参考图后此处显示叠加预览');
      return;
    }
    const img = state.refImg;
    if (overlayCanvas.width !== img.naturalWidth || overlayCanvas.height !== img.naturalHeight) {
      overlayCanvas.width = img.naturalWidth;
      overlayCanvas.height = img.naturalHeight;
    }
    const ctx = overlayCanvas.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(img, 0, 0);

    if (state.scanImg && state.fit) {
      const m = state.fit.matrix;
      // canvas 变换矩阵 [a c e; b d f] ↔ u=a·x+b·y+c, v=d·x+e·y+f
      ctx.setTransform(m.a, m.d, m.b, m.e, m.c, m.f);
      ctx.globalAlpha = state.opacity;
      ctx.drawImage(state.scanImg, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    const scale = canvasScale(overlayCanvas);
    state.points.forEach((pt, i) => {
      const s = markerStyle(i);
      drawMarker(ctx, pt.ref, String(i + 1), s.color, scale, { dashed: s.dashed, ring: s.ring });
    });
  }

  // ---------- 面板渲染 ----------
  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (kind || 'info');
  }

  function fmt(v, digits) {
    return Number(v).toFixed(digits === undefined ? 2 : digits);
  }

  // 留出验证汇总文案：仅统计可验证点；零个可验证点时显示不可用
  function looSummary() {
    const v = state.fit && state.fit.validation;
    if (!v) return '';
    if (v.verifiableCount === 0) return '留出验证：不可用（无可验证点）';
    return `留出验证 RMSE = ${fmt(v.rmse, 3)} px（${v.verifiableCount} 点可验证）· ` +
      `最差 #${v.maxIndex + 1}（${fmt(v.maxError, 3)} px）`;
  }

  function renderStatus() {
    const n = state.points.length;
    if (!state.refImg || !state.scanImg) {
      setStatus('请上传参考图与扫描图（或点击“载入示例图像”），然后在两图上成对点击控制点。', 'info');
      return;
    }
    if (state.pending.ref || state.pending.scan) {
      const wait = state.pending.ref ? '扫描图' : '参考图';
      setStatus(`已记录半对点，请在${wait}上点击对应位置完成配对（Esc 取消）。`, 'info');
      return;
    }
    if (n < Affine.MIN_POINTS) {
      setStatus(`已有 ${n} 对控制点，至少还需 ${Affine.MIN_POINTS - n} 对才能拟合。`, 'info');
      return;
    }
    if (state.fitError) {
      // 找不到至少三对非共线内点时：保留点对，说明原因（导出按钮随后禁用）
      setStatus('无法拟合：' + state.fitError, 'error');
      return;
    }
    const f = state.fit;
    if (state.robust) {
      setStatus(
        `稳健拟合成功 · 内点 ${f.inlierCount} 对 / 外点 ${f.outlierCount} 对` +
        `（容差 ${fmt(f.tolerancePx, 2)} px，评估 ${f.candidatesEvaluated} 个三点候选）· ` +
        `内点 RMSE = ${fmt(f.rmse, 3)} px · 外点已在图与表中红色标出，不计入 RMSE`,
        'ok'
      );
    } else {
      setStatus(
        `拟合成功 · ${f.pointCount} 对点 · RMSE = ${fmt(f.rmse, 3)} px · ` +
        `最大残差点：#${f.maxIndex + 1}（${fmt(f.residuals[f.maxIndex], 3)} px，已橙色标出）`,
        'ok'
      );
    }
    const loo = looSummary();
    if (loo) statusEl.textContent += ' · ' + loo;
  }

  function renderFitPanel() {
    if (!state.fit) {
      fitPanelEl.innerHTML = state.fitError
        ? `<p class="err">${state.fitError}</p>`
        : '<p class="muted">满足条件后此处显示六参数矩阵。</p>';
      return;
    }
    const m = state.fit.matrix;
    const rows = ['a', 'b', 'c', 'd', 'e', 'f']
      .map((k) => `<div class="mrow"><span>${k}</span><code>${Number(m[k]).toPrecision(8)}</code></div>`)
      .join('');
    let extra;
    if (state.robust) {
      extra =
        `<p class="muted">稳健模式：像素容差 ${fmt(state.fit.tolerancePx, 2)} px · ` +
        `内点 ${state.fit.inlierCount} / 共 ${state.fit.pointCount} 对（外点 ${state.fit.outlierCount} 对不参与拟合与 RMSE）</p>`;
    } else {
      extra = '<p class="muted">经典最小二乘：全部控制点参与拟合</p>';
    }
    fitPanelEl.innerHTML =
      `<div class="matrix">${rows}</div>` +
      `<p class="muted">u = a·x + b·y + c<br>v = d·x + e·y + f（扫描图 → 参考图）</p>` +
      extra +
      `<p>${state.robust ? '内点 RMSE' : 'RMSE'}：<strong>${fmt(state.fit.rmse, 4)}</strong> px</p>` +
      looPanelHtml(state.fit.validation);
  }

  // 拟合面板中的逐点留出验证小结（与 /api/fit 的 validation 字段同源）
  function looPanelHtml(v) {
    if (!v) return '';
    if (v.verifiableCount === 0) {
      return '<p class="muted">逐点留出验证：<strong>不可用</strong>' +
        '（参与点不足 4 个或留出后近共线）</p>';
    }
    return `<p class="muted">逐点留出验证（移除该点后重拟合预测）：</p>` +
      `<p>验证 RMSE：<strong>${fmt(v.rmse, 4)}</strong> px · ` +
      `最大验证误差：<strong>${fmt(v.maxError, 4)}</strong> px（#${v.maxIndex + 1}）<br>` +
      `可验证点 ${v.verifiableCount} / 参与点 ${v.participantCount}` +
      (v.participantCount - v.verifiableCount > 0 ? '，其余为无法验证' : '') +
      (v.points.some((p) => p.status === 'excluded')
        ? `，外点 ${v.points.filter((p) => p.status === 'excluded').length} 个不参与`
        : '') +
      `</p>`;
  }

  // 残差表「留出验证」单元格：参与点显示留出重拟合后的预测误差；
  // 无法验证（参与点不足 4 个或留出后近共线）/ 外点不参与均显式标注，绝不拿残差充数
  function looCell(i) {
    const v = state.fit && state.fit.validation;
    if (!v || !v.points[i]) return '<td class="loo-na">—</td>';
    const p = v.points[i];
    if (p.status === 'excluded') return '<td class="loo-na">不参与</td>';
    if (p.status === 'unverifiable') return '<td class="loo-na">无法验证</td>';
    const maxCls = i === v.maxIndex ? ' class="loo-max"' : '';
    return `<td${maxCls}>${fmt(p.error, 3)}</td>`;
  }

  function renderTable() {
    ptCountEl.textContent = state.points.length ? `（${state.points.length} 对）` : '';
    ptTableBody.innerHTML = state.points.map((pt, i) => {
      const r = state.fit ? fmt(state.fit.residuals[i], 3) : '—';
      let cls = '';
      let verdict = '';
      if (state.fit && state.fit.inliers) {
        if (!state.fit.inliers[i]) {
          cls = ' class="out-row"';
          verdict = '<span class="badge out">外点</span>';
        } else {
          verdict = '<span class="badge in">内点</span>';
          if (i === state.fit.maxIndex) cls = ' class="max-row"';
        }
      } else if (state.fit && i === state.fit.maxIndex) {
        cls = ' class="max-row"';
      }
      return `<tr${cls}>
        <td>${i + 1}</td>
        <td>${fmt(pt.scan.x, 1)}, ${fmt(pt.scan.y, 1)}</td>
        <td>${fmt(pt.ref.x, 1)}, ${fmt(pt.ref.y, 1)}</td>
        <td>${r}</td>
        ${looCell(i)}
        <td>${verdict}</td>
        <td><button class="del" data-id="${pt.id}" title="删除该点">✕</button></td>
      </tr>`;
    }).join('');
  }

  // 导出校准扫描图的前置条件；不满足时给出中文原因（禁用提示 + 点击兜底）
  function exportImageReadiness() {
    if (!state.refImg || !state.scanImg) {
      return { ok: false, reason: '图像缺失，请先上传参考图与扫描图' };
    }
    if (state.fitError) {
      return { ok: false, reason: '拟合无效：' + state.fitError };
    }
    if (!state.fit) {
      return { ok: false, reason: `拟合无效：控制点不足 ${Affine.MIN_POINTS} 对` };
    }
    const chk = Affine.checkExportMatrix(state.fit.matrix);
    if (!chk.ok) return { ok: false, reason: chk.reason };
    return { ok: true };
  }

  function renderButtons() {
    const hasFit = !!state.fit;
    btnExportMatrix.disabled = !hasFit;
    btnExportResiduals.disabled = !hasFit;
    btnClear.disabled = state.points.length === 0 && !state.pending.ref && !state.pending.scan;
    // 导出校准扫描图：随重算结果实时启用/禁用，禁用时说明原因
    const ready = exportImageReadiness();
    btnExportImage.disabled = !ready.ok;
    btnExportImage.title = ready.ok
      ? '下载与参考图同尺寸的 PNG：仅含按最终矩阵变换后的扫描图（逆仿射 + 双线性插值，本地处理）'
      : ready.reason;
    exportImgHint.textContent = ready.ok ? '' : '暂不可导出校准扫描图：' + ready.reason;
  }

  function render() {
    drawImageCanvas(refCanvas, state.refImg, 'ref');
    drawImageCanvas(scanCanvas, state.scanImg, 'scan');
    drawOverlay();
    renderStatus();
    renderFitPanel();
    renderTable();
    renderButtons();
  }

  // ---------- 导出 ----------
  function downloadJSON(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  }

  function exportMatrix() {
    if (!state.fit) return;
    const m = state.fit.matrix;
    const f = state.fit;
    downloadJSON('affine-matrix.json', {
      description: '仿射变换六参数：u = a·x + b·y + c，v = d·x + e·y + f（扫描图坐标 → 参考图坐标）',
      mode: state.robust ? 'robust' : 'leastSquares',
      matrix: m,
      matrixRowMajor: [[m.a, m.b, m.c], [m.d, m.e, m.f], [0, 0, 1]],
      rmse: f.rmse,
      rmseScope: state.robust ? 'inliers' : 'all',
      pointCount: f.pointCount,
      ...(state.robust ? {
        tolerancePx: f.tolerancePx,
        inlierCount: f.inlierCount,
        outlierCount: f.outlierCount
      } : {}),
      looValidation: looSummaryForExport(f.validation),
      exportedAt: new Date().toISOString()
    });
  }

  // 留出验证汇总（导出用）：零个可验证点时各统计量为 null
  function looSummaryForExport(v) {
    if (!v) return null;
    return {
      participantCount: v.participantCount,
      verifiableCount: v.verifiableCount,
      rmse: v.rmse,
      maxError: v.maxError,
      maxIndex: v.maxIndex >= 0 ? v.maxIndex + 1 : null // 1 起编号；不可用时为 null
    };
  }

  function exportResiduals() {
    if (!state.fit) return;
    const f = state.fit;
    const loo = f.validation;
    downloadJSON('residuals.json', {
      mode: state.robust ? 'robust' : 'leastSquares',
      rmse: f.rmse,
      rmseScope: state.robust ? 'inliers' : 'all',
      ...(state.robust ? { tolerancePx: f.tolerancePx } : {}),
      inlierCount: state.robust ? f.inlierCount : f.pointCount,
      outlierCount: state.robust ? f.outlierCount : 0,
      maxResidualIndex: f.maxIndex + 1,
      looValidation: looSummaryForExport(loo),
      points: state.points.map((pt, i) => ({
        id: i + 1,
        scan: pt.scan,
        ref: pt.ref,
        residualPx: f.residuals[i],
        isInlier: isInlier(i),
        isMaxResidual: i === f.maxIndex,
        // 逐点留出验证：'ok' 带误差；'unverifiable' 无法验证；'excluded' 外点不参与
        looStatus: loo ? loo.points[i].status : 'unverifiable',
        looErrorPx: loo ? loo.points[i].error : null
      })),
      exportedAt: new Date().toISOString()
    });
  }

  // 导出校准扫描图：与参考图原始宽高一致的 PNG，仅含按最终矩阵变换后的
  // 扫描图（无参考底图、无标记、无预览透明度）；像素处理全部在浏览器本地完成
  function exportCalibratedImage() {
    const ready = exportImageReadiness();
    if (!ready.ok) { // 按钮禁用时的兜底（如键盘触发）
      setStatus('无法导出校准扫描图：' + ready.reason, 'error');
      return;
    }
    try {
      // 点击时重新读取当前扫描图像素（本地 canvas，不上传服务器）
      const sw = state.scanImg.naturalWidth;
      const sh = state.scanImg.naturalHeight;
      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = sw;
      srcCanvas.height = sh;
      const sctx = srcCanvas.getContext('2d');
      sctx.drawImage(state.scanImg, 0, 0);
      const srcData = sctx.getImageData(0, 0, sw, sh).data;

      // 输出尺寸 = 参考图原始宽高；逆仿射重采样（四邻双线性插值）
      const outW = state.refImg.naturalWidth;
      const outH = state.refImg.naturalHeight;
      const pixels = Affine.transformRGBA(srcData, sw, sh, state.fit.matrix, outW, outH);

      const outCanvas = document.createElement('canvas');
      outCanvas.width = outW;
      outCanvas.height = outH;
      outCanvas.getContext('2d').putImageData(new ImageData(pixels, outW, outH), 0, 0);
      outCanvas.toBlob((blob) => {
        if (!blob) {
          setStatus('导出校准扫描图失败：浏览器未能生成 PNG。', 'error');
          return;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'calibrated-scan.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(a.href);
        setStatus(
          `已导出校准扫描图 calibrated-scan.png（${outW}×${outH} PNG，` +
          `仅含按最终矩阵变换后的扫描图，模式：${state.robust ? '稳健' : '经典最小二乘'}）。`,
          'ok'
        );
      }, 'image/png');
    } catch (err) {
      setStatus('无法导出校准扫描图：' + (err.message || String(err)), 'error');
    }
  }

  // ---------- 示例图像 ----------
  function drawSampleContent(g, w, h) {
    g.fillStyle = '#f8fafc';
    g.fillRect(0, 0, w, h);
    // 网格
    g.strokeStyle = '#cbd5e1';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    // 套色十字（便于点击的标记）
    const crosses = [[90, 90], [w - 90, 110], [120, h - 100], [w - 130, h - 90], [w / 2, h / 2 - 40], [w / 2 + 160, 90]];
    crosses.forEach(([cx, cy], i) => {
      g.strokeStyle = ['#dc2626', '#2563eb', '#059669', '#7c3aed', '#ea580c', '#0891b2'][i % 6];
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx, cy, 14, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(cx - 22, cy); g.lineTo(cx + 22, cy);
      g.moveTo(cx, cy - 22); g.lineTo(cx, cy + 22);
      g.stroke();
    });
    g.fillStyle = '#334155';
    g.font = 'bold 28px system-ui, sans-serif';
    g.textAlign = 'left';
    g.fillText('REGISTRATION SAMPLE · 套色校准示例', 30, h - 30);
  }

  function loadSampleImages() {
    const w = 960, h = 640;
    const c1 = document.createElement('canvas');
    c1.width = w; c1.height = h;
    drawSampleContent(c1.getContext('2d'), w, h);

    // 模拟扫描偏移：旋转 + 缩放 + 平移
    const c2 = document.createElement('canvas');
    c2.width = w; c2.height = h;
    const g2 = c2.getContext('2d');
    g2.fillStyle = '#ffffff';
    g2.fillRect(0, 0, w, h);
    g2.setTransform(0.9962, 0.0119, -0.0105, 0.9974, 17.5, -11.2);
    g2.drawImage(c1, 0, 0);

    const refImg = new Image();
    const scanImg = new Image();
    let loaded = 0;
    const done = () => {
      loaded += 1;
      if (loaded < 2) return;
      state.refImg = refImg;
      state.scanImg = scanImg;
      clearPoints();
    };
    refImg.onload = done;
    scanImg.onload = done;
    refImg.src = c1.toDataURL('image/png');
    scanImg.src = c2.toDataURL('image/png');
  }

  // ---------- 事件绑定 ----------
  function init() {
    $('refFile').addEventListener('change', (e) => handleFile(e.target, 'ref'));
    $('scanFile').addEventListener('change', (e) => handleFile(e.target, 'scan'));
    $('btnSample').addEventListener('click', loadSampleImages);
    btnClear.addEventListener('click', clearPoints);
    btnExportMatrix.addEventListener('click', exportMatrix);
    btnExportResiduals.addEventListener('click', exportResiduals);
    btnExportImage.addEventListener('click', exportCalibratedImage);

    opacityInput.addEventListener('input', () => {
      state.opacity = parseFloat(opacityInput.value);
      opacityVal.textContent = Math.round(state.opacity * 100) + '%';
      drawOverlay();
    });

    // 稳健模式开关：切换后立即重算，并同步容差输入的可用状态
    robustModeInput.addEventListener('change', () => {
      state.robust = !!robustModeInput.checked;
      toleranceInput.disabled = !state.robust;
      recompute();
    });

    // 像素容差：编辑（input）即时同步重算；非法值给出提示并禁用导出
    toleranceInput.addEventListener('input', () => {
      const v = parseFloat(toleranceInput.value);
      if (!Number.isFinite(v) || v < 0) {
        state.tolerancePx = NaN;
        state.fit = null;
        state.fitError = '像素容差必须为不小于 0 的数字（参考图像素）。';
        render();
        return;
      }
      state.tolerancePx = v;
      recompute();
    });

    ptTableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('button.del');
      if (btn) deletePoint(Number(btn.dataset.id));
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (state.pending.ref || state.pending.scan)) {
        state.pending = { ref: null, scan: null };
        render();
      }
    });

    bindCanvas(refCanvas, 'ref');
    bindCanvas(scanCanvas, 'scan');
    render();
  }

  init();
})();
