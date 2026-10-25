// shot.mjs --eval 로 페이지 안에서 실행하는 성능 측정 (?debug 필요)
(async () => {
  const o = window.__office;
  if (!o) return 'no __office (open with ?debug)';
  const gl = o.gl, ctx = gl.getContext(), px = new Uint8Array(4);
  const sync = () => ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
  for (let i = 0; i < 10; i++) { gl.render(o.scene, o.camera); sync(); }
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) { gl.render(o.scene, o.camera); sync(); }
  const renderMs = (performance.now() - t0) / 100;
  const calls = gl.info.render.calls, triangles = gl.info.render.triangles;
  const f0 = gl.info.render.frame;
  await new Promise(r => setTimeout(r, 5000));
  return {
    renderMs: +renderMs.toFixed(2),
    framesLast5s: gl.info.render.frame - f0,
    moving: o.activity.count,
    workers: document.querySelectorAll('.worker-tag').length,
    drawCalls: calls,
    triangles,
    canvas: `${gl.domElement.width}x${gl.domElement.height}`,
    dpr: devicePixelRatio,
  };
})()
