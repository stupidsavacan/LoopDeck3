/** Fit each face independently; overflow beyond the readable minimum stays scrollable. */
export function observeFlashcardLayout(faces: HTMLElement[]): () => void {
  let disposed = false;
  let frame: number | undefined;
  const fit = () => {
    frame = undefined;
    if (disposed) return;
    for (const face of faces) fitFace(face);
  };
  const schedule = () => {
    if (!disposed && frame === undefined) frame = window.requestAnimationFrame(fit);
  };
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
  for (const face of faces) {
    const content = face.querySelector<HTMLElement>('.flashcard-content')!;
    observer?.observe(content);
    // Image mounts change size after asynchronous resolution, including load failures.
    for (const child of content.children) {
      if (!child.classList.contains('flashcard-term')) observer?.observe(child);
    }
  }
  window.addEventListener('resize', schedule);
  document.fonts?.addEventListener('loadingdone', schedule);
  void document.fonts?.ready.then(schedule);
  schedule();
  return () => {
    disposed = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', schedule);
    document.fonts?.removeEventListener('loadingdone', schedule);
  };
}

function fitFace(face: HTMLElement): void {
  const content = face.querySelector<HTMLElement>('.flashcard-content')!;
  const term = content.querySelector<HTMLElement>('.flashcard-term')!;
  if (!content.clientHeight || !content.clientWidth) return;
  const scrollTop = content.scrollTop;
  term.style.removeProperty('font-size');
  const maximum = parseFloat(getComputedStyle(term).fontSize);
  term.style.fontSize = 'var(--flashcard-min-term-size)';
  const minimum = Math.min(maximum, parseFloat(getComputedStyle(term).fontSize));
  const minimumHeight = term.offsetHeight;
  const extras = [...content.children].reduce((height, child) => {
    if (child === term || !(child instanceof HTMLElement)) return height;
    const style = getComputedStyle(child);
    return height + child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }, 0);
  // If supporting material alone would force overflow, let it scroll rather than
  // shrinking a short answer to make room for a large image or explanation.
  const available = content.clientHeight - (extras + minimumHeight <= content.clientHeight ? extras : 0);
  const fits = (size: number) => {
    term.style.fontSize = `${size}px`;
    return Math.max(term.offsetHeight, term.scrollHeight) <= available - 1 && term.scrollWidth <= content.clientWidth;
  };
  if (!fits(maximum)) {
    let low = minimum;
    let high = maximum;
    if (fits(minimum)) {
      while (high - low > 0.25) {
        const middle = (low + high) / 2;
        if (fits(middle)) low = middle;
        else high = middle;
      }
    }
    term.style.fontSize = `${low}px`;
  }
  content.scrollTop = scrollTop;
}
