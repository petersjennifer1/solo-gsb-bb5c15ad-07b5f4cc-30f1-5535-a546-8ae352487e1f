/* affine.js RGBA 逆仿射重采样单元测试：node test/warp.test.js */
'use strict';

const assert = require('assert');
const Affine = require('../public/js/affine.js');

function makeImageData(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      const o = (y * w + x) * 4;
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width: w, height: h, data };
}

const ID = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };
const px = (img, x, y) => img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4);

// 1. 恒等变换：像素中心 (i+0.5,j+0.5) 精确取回该像素，尺寸保持
{
  const src = makeImageData(3, 2, (x, y) => [10 * x + 1, 20 * y + 2, 30 * x + 40 * y + 3, 255]);
  const out = Affine.warpRGBA(src, ID, 3, 2);
  assert.strictEqual(out.width, 3);
  assert.strictEqual(out.height, 2);
  assert.strictEqual(out.data.length, 3 * 2 * 4);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 3; x++) {
      assert.deepStrictEqual([...px(out, x, y)], [...px(src, x, y)],
        `恒等变换下 (${x},${y}) 应原样返回`);
    }
  }
  console.log('✓ 恒等变换：像素中心精确取回原像素，输出尺寸正确');
}

// 2. 整数平移 (1,0)：内容整体右移 1 像素，首列透明黑、末列移出
{
  const src = makeImageData(2, 1, (x) => [100, 150, 200, 255].map((v) => (x === 0 ? v : v - 50)));
  const out = Affine.warpRGBA(src, { a: 1, b: 0, c: 1, d: 0, e: 1, f: 0 }, 2, 1);
  assert.deepStrictEqual([...px(out, 0, 0)], [0, 0, 0, 0], '移出区域应为透明黑');
  assert.deepStrictEqual([...px(out, 1, 0)], [...px(src, 0, 0)], '右移后 (1,0) 应为原 (0,0)');
  console.log('✓ 整数平移：越界邻点按透明黑处理，内部像素精确保留');
}

// 3. 半像素平移 (0.5, 0)：两个不透明等权邻点双线性混合（四舍五入）
{
  const src = makeImageData(2, 1, () => [0, 0, 0, 0]);
  src.data[0] = 10; src.data[1] = 20; src.data[2] = 30; src.data[3] = 255;
  src.data[4] = 20; src.data[5] = 40; src.data[6] = 60; src.data[7] = 255;
  const out = Affine.warpRGBA(src, { a: 1, b: 0, c: 0.5, d: 0, e: 1, f: 0 }, 2, 1);
  // 边缘：半权重落在界外（透明黑），预乘混合后还原 RGB 保持原色、alpha 减半
  assert.deepStrictEqual([...px(out, 0, 0)], [10, 20, 30, 128], '边缘半像素：与透明黑预乘混合后 RGB 不被压暗');
  assert.deepStrictEqual([...px(out, 1, 0)], [15, 30, 45, 255], '内部半像素：两邻点等权平均');
  console.log('✓ 半像素平移：双线性插值与四舍五入正确');
}

// 4. 预乘 alpha：半透明像素与透明黑混合后颜色不被压暗（无黑色镶边）
{
  const src = makeImageData(2, 1, () => [0, 0, 0, 0]);
  // (0,0) 半透明红 (200,0,0,128)；(1,0) 透明黑
  src.data[0] = 200; src.data[3] = 128;
  const out = Affine.warpRGBA(src, { a: 1, b: 0, c: 0.5, d: 0, e: 1, f: 0 }, 2, 1);
  assert.deepStrictEqual([...px(out, 1, 0)], [200, 0, 0, 64],
    '预乘插值后应还原 RGB：(200,0,0,64)，而非 (100,0,0,64)');
  console.log('✓ 预乘 alpha：颜色先乘 alpha 插值、输出时还原');
}

// 5. alpha 为零时 RGB 归零
{
  const src = makeImageData(1, 1, () => [123, 200, 50, 0]);
  const out = Affine.warpRGBA(src, ID, 1, 1);
  assert.deepStrictEqual([...px(out, 0, 0)], [0, 0, 0, 0], '完全透明像素 RGB 必须归零');
  console.log('✓ alpha 为零时 RGB 归零');
}

// 6. 90° 旋转：源像素精确映射到目标位置（像素中心约定）
{
  // 正向矩阵：输出坐标 (u,v) = (-y, x)，即源内容在输出中顺时针旋转 90°
  // 2×2 源：(0,0)=红 (1,0)=绿 (0,1)=蓝 (1,1)=白
  const src = makeImageData(2, 2, (x, y) => {
    if (x === 0 && y === 0) return [255, 0, 0, 255];
    if (x === 1 && y === 0) return [0, 255, 0, 255];
    if (x === 0 && y === 1) return [0, 0, 255, 255];
    return [255, 255, 255, 255];
  });
  // 绕画布中心 (1,1) 逆时针旋转 90°：u = 2 - y，v = x（像素中心精确互换）
  const m = { a: 0, b: -1, c: 2, d: 1, e: 0, f: 0 };
  const out = Affine.warpRGBA(src, m, 2, 2);
  assert.deepStrictEqual([...px(out, 1, 0)], [255, 0, 0, 255]);   // 红 (0,0) → (1,0)
  assert.deepStrictEqual([...px(out, 1, 1)], [0, 255, 0, 255]);   // 绿 (1,0) → (1,1)
  assert.deepStrictEqual([...px(out, 0, 0)], [0, 0, 255, 255]);   // 蓝 (0,1) → (0,0)
  assert.deepStrictEqual([...px(out, 0, 1)], [255, 255, 255, 255]); // 白 (1,1) → (0,1)
  console.log('✓ 90° 旋转：四邻插值在中心对齐时给出精确映射');
}

// 7. 非整数缩放（0.5×）内部输出为 2×2 邻域双线性混合，无 NaN，通道全部 0～255
{
  const src = makeImageData(4, 4, (x, y) => [40 * x + 1, 40 * y + 1, 200, 255]);
  const out = Affine.warpRGBA(src, { a: 0.5, b: 0, c: 0, d: 0, e: 0.5, f: 0 }, 8, 8);
  for (let k = 0; k < out.data.length; k++) {
    assert.ok(Number.isInteger(out.data[k]) && out.data[k] >= 0 && out.data[k] <= 255,
      `通道 ${k} 越界: ${out.data[k]}`);
  }
  // 输出 (1,1) 中心 (1.5,1.5) 映射到源 (3.0,3.0)：x/y 各在 2、3 邻点间 0.5 混合
  const r = px(out, 1, 1)[0];
  assert.ok(Math.abs(r - 101) <= 1, `0.5× 缩放下红色通道应约 101，实际 ${r}`);
  console.log('✓ 非整数缩放：双线性权重正确，通道均四舍五入到 0～255');
}

// 8. 矩阵校验：非有限参数 / 缺字段 → BAD_MATRIX
{
  assert.throws(() => Affine.warpRGBA(makeImageData(1, 1, () => [0, 0, 0, 0]),
    { a: NaN, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1), (e) => e.code === 'BAD_MATRIX');
  assert.throws(() => Affine.warpRGBA(makeImageData(1, 1, () => [0, 0, 0, 0]),
    { a: 1, b: 0, c: 0, d: 0, e: 1 }, 1, 1), (e) => e.code === 'BAD_MATRIX');
  assert.throws(() => Affine.warpRGBA(makeImageData(1, 1, () => [0, 0, 0, 0]),
    { a: Infinity, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1), (e) => e.code === 'BAD_MATRIX');
  console.log('✓ 非有限 / 缺字段矩阵抛出 BAD_MATRIX');
}

// 9. 行列式退化：|det| ≤ 1e-12 → SINGULAR_MATRIX；阈值上方可用
{
  const tiny = Affine.SINGULAR_DET_EPS;
  assert.throws(() => Affine.warpRGBA(makeImageData(1, 1, () => [1, 2, 3, 255]),
    { a: tiny, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1), (e) => e.code === 'SINGULAR_MATRIX');
  assert.throws(() => Affine.warpRGBA(makeImageData(1, 1, () => [1, 2, 3, 255]),
    { a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 }, 1, 1), (e) => e.code === 'SINGULAR_MATRIX');
  // det = 2e-12 > 1e-12：允许（逆映射数值极端但不抛错）
  const out = Affine.warpRGBA(makeImageData(1, 1, () => [1, 2, 3, 255]),
    { a: 2 * tiny, b: 0, c: 0, d: 0, e: 1, f: 0 }, 1, 1);
  assert.strictEqual(out.width, 1);
  console.log('✓ 行列式 |det| ≤ 1e-12 抛出 SINGULAR_MATRIX，阈值上方放行');
}

// 10. 非法像素数据 / 尺寸 → BAD_IMAGEDATA
{
  assert.throws(() => Affine.warpRGBA(null, ID, 1, 1), (e) => e.code === 'BAD_IMAGEDATA');
  assert.throws(() => Affine.warpRGBA({ width: 0, height: 1, data: new Uint8ClampedArray(0) }, ID, 1, 1),
    (e) => e.code === 'BAD_IMAGEDATA');
  assert.throws(() => Affine.warpRGBA(makeImageData(2, 2, () => [0, 0, 0, 0]), ID, 0, 2),
    (e) => e.code === 'BAD_IMAGEDATA');
  assert.throws(() => Affine.warpRGBA({ width: 2, height: 2, data: new Uint8ClampedArray(3) }, ID, 2, 2),
    (e) => e.code === 'BAD_IMAGEDATA');
  console.log('✓ 像素数据 / 输出尺寸非法抛出 BAD_IMAGEDATA');
}

// 11. invertAffine：逆矩阵与正矩阵复合为恒等
{
  const m = { a: 1.02, b: 0.01, c: 15, d: -0.005, e: 0.98, f: -20 };
  const inv = Affine.invertAffine(m);
  for (const p of [{ x: 0, y: 0 }, { x: 123.4, y: -56.7 }, { x: 999, y: 1 }]) {
    const q = Affine.applyMatrix(m, p);
    const back = Affine.applyMatrix(inv, q);
    assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9,
      `逆映射往返误差过大: ${back.x},${back.y} vs ${p.x},${p.y}`);
  }
  assert.throws(() => Affine.invertAffine({ a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 }),
    (e) => e.code === 'SINGULAR_MATRIX');
  console.log('✓ invertAffine 可独立调用，往返复合为恒等');
}

// 12. 纯函数：不修改输入像素缓冲
{
  const src = makeImageData(2, 2, (x, y) => [x * 10, y * 10, 50, 128]);
  const snapshot = Buffer.from(src.data);
  Affine.warpRGBA(src, { a: 0.5, b: 0, c: 3, d: 0, e: 0.5, f: -1 }, 4, 4);
  assert.ok(Buffer.from(src.data).equals(snapshot), 'warpRGBA 不得修改输入数据');
  console.log('✓ warpRGBA 为纯函数，输入缓冲不变');
}

console.log('\nRGBA 重采样测试全部通过 ✔');
