// Screenshot lightbox. Any `a.zoomable` that links to an image opens it here
// instead of navigating (without JS the link just opens the image).
// Wheel, pinch and double-click zoom up to 3x, drag pans, arrows step through the
// screenshots visible on the page, Esc / backdrop click / the close button close.

const MAX_SCALE = 3;

let dialog: HTMLDialogElement | null = null;
let stage: HTMLDivElement;
let image: HTMLImageElement;
let caption: HTMLParagraphElement;
let counter: HTMLSpanElement;
let prevButton: HTMLButtonElement;
let nextButton: HTMLButtonElement;
let zoomButton: HTMLButtonElement;

let items: HTMLAnchorElement[] = [];
let index = 0;
let scale = 1;
let panX = 0;
let panY = 0;

const pointers = new Map<number, { x: number; y: number }>();
let pinch: { distance: number; scale: number } | null = null;
let drag: { x: number; y: number; panX: number; panY: number } | null = null;
let movedSincePointerDown = false;

function build(): HTMLDialogElement {
  const element = document.createElement('dialog');
  element.className = 'lightbox';
  element.setAttribute('aria-label', 'Screenshot viewer');
  element.innerHTML = `
    <div class="lb-stage"><img class="lb-img" alt="" draggable="false" /></div>
    <div class="lb-bar">
      <button type="button" class="lb-btn lb-prev" aria-label="Previous screenshot">&larr;</button>
      <p class="lb-caption"></p>
      <span class="lb-count" aria-live="polite"></span>
      <button type="button" class="lb-btn lb-next" aria-label="Next screenshot">&rarr;</button>
      <button type="button" class="lb-btn lb-zoom" aria-label="Zoom in">+</button>
      <button type="button" class="lb-btn lb-close" aria-label="Close">&times;</button>
    </div>`;
  document.body.append(element);

  stage = element.querySelector('.lb-stage')!;
  image = element.querySelector('.lb-img')!;
  caption = element.querySelector('.lb-caption')!;
  counter = element.querySelector('.lb-count')!;
  prevButton = element.querySelector('.lb-prev')!;
  nextButton = element.querySelector('.lb-next')!;
  zoomButton = element.querySelector('.lb-zoom')!;

  prevButton.addEventListener('click', () => step(-1));
  nextButton.addEventListener('click', () => step(1));
  zoomButton.addEventListener('click', () => zoomTo(scale > 1 ? 1 : 2, 0, 0));
  element.querySelector('.lb-close')!.addEventListener('click', () => element.close());
  element.addEventListener('close', () => reset());

  // A click on the empty area around the image closes, a drag does not.
  stage.addEventListener('click', (event) => {
    if (event.target === stage && !movedSincePointerDown) element.close();
  });
  image.addEventListener('dblclick', (event) => {
    const point = fromCenter(event.clientX, event.clientY);
    zoomTo(scale > 1 ? 1 : 2.5, point.x, point.y);
  });
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const point = fromCenter(event.clientX, event.clientY);
      zoomTo(scale * Math.exp(-event.deltaY * 0.0025), point.x, point.y);
    },
    { passive: false },
  );
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);

  element.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === '+' || event.key === '=') zoomTo(scale * 1.5, 0, 0);
    else if (event.key === '-') zoomTo(scale / 1.5, 0, 0);
    else if (event.key === '0') zoomTo(1, 0, 0);
    else return;
    event.preventDefault();
  });
  return element;
}

/** A point relative to the stage centre, which is where the image is centred. */
function fromCenter(clientX: number, clientY: number) {
  const box = stage.getBoundingClientRect();
  return { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 };
}

function apply() {
  // Keep the zoomed image covering the stage: no panning into empty space.
  const maxX = Math.max(0, (image.offsetWidth * scale - stage.clientWidth) / 2);
  const maxY = Math.max(0, (image.offsetHeight * scale - stage.clientHeight) / 2);
  panX = Math.min(maxX, Math.max(-maxX, panX));
  panY = Math.min(maxY, Math.max(-maxY, panY));
  image.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  stage.classList.toggle('is-zoomed', scale > 1);
  zoomButton.textContent = scale > 1 ? '−' : '+';
  zoomButton.setAttribute('aria-label', scale > 1 ? 'Zoom out' : 'Zoom in');
}

/** Zoom to `next`, keeping the image point under (x, y) where it is. */
function zoomTo(next: number, x: number, y: number) {
  const clamped = Math.min(MAX_SCALE, Math.max(1, next));
  const ratio = clamped / scale;
  panX = x - (x - panX) * ratio;
  panY = y - (y - panY) * ratio;
  scale = clamped;
  apply();
}

function reset() {
  scale = 1;
  panX = 0;
  panY = 0;
  pointers.clear();
  pinch = null;
  drag = null;
  if (dialog) apply();
}

function onPointerDown(event: PointerEvent) {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  stage.setPointerCapture(event.pointerId);
  movedSincePointerDown = false;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
    drag = null;
  } else if (pointers.size === 1 && scale > 1) {
    drag = { x: event.clientX, y: event.clientY, panX, panY };
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const middle = fromCenter((a.x + b.x) / 2, (a.y + b.y) / 2);
    zoomTo((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance, middle.x, middle.y);
    movedSincePointerDown = true;
  } else if (drag) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) movedSincePointerDown = true;
    panX = drag.panX + dx;
    panY = drag.panY + dy;
    stage.classList.add('is-dragging');
    apply();
  }
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    drag = null;
    stage.classList.remove('is-dragging');
  }
}

function show(position: number) {
  index = (position + items.length) % items.length;
  const link = items[index];
  const thumb = link.querySelector('img');
  reset();
  image.src = link.href;
  image.alt = thumb?.alt ?? '';
  caption.textContent = link.dataset.caption || thumb?.alt || '';
  const several = items.length > 1;
  prevButton.hidden = !several;
  nextButton.hidden = !several;
  counter.hidden = !several;
  counter.textContent = several ? `${index + 1} / ${items.length}` : '';
}

function step(direction: number) {
  if (items.length > 1) show(index + direction);
}

document.addEventListener('click', (event) => {
  const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a.zoomable');
  if (!link || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  // The group is every screenshot the reader can currently see on this page
  // (the landing hides the shot that does not match the theme).
  items = [...document.querySelectorAll<HTMLAnchorElement>('a.zoomable')].filter(
    (item) => item.getClientRects().length > 0,
  );
  dialog ??= build();
  show(Math.max(0, items.indexOf(link)));
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('.lb-close')!.focus();
});
