// Drag a rectangle; on release it goes to the main process in window coordinates (CSS px = screen points).
const sel = document.getElementById('sel'), size = document.getElementById('size');
let start = null, rect = null;

function draw(e) {
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
  rect = { x, y, width: Math.abs(e.clientX - start.x), height: Math.abs(e.clientY - start.y) };
  Object.assign(sel.style, { left: `${x}px`, top: `${y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  size.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

document.addEventListener('pointerdown', e => {
  if (e.button !== 0) { window.zone.cancel(); return; }
  start = { x: e.clientX, y: e.clientY };
  document.body.classList.add('dragging');
  sel.hidden = false;
  draw(e);
});
document.addEventListener('pointermove', e => { if (start) draw(e); });
document.addEventListener('pointerup', e => {
  if (!start) return;
  draw(e);
  start = null;
  if (rect.width < 8 || rect.height < 8) { sel.hidden = true; document.body.classList.remove('dragging'); return; }
  window.zone.done(rect);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') window.zone.cancel(); });
document.addEventListener('contextmenu', e => { e.preventDefault(); window.zone.cancel(); });
