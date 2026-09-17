/**
 * Where the battlefield actually is, published as CSS custom properties.
 *
 * The canvas is FIT-scaled from a fixed 16:9 world, so inside a stage of any
 * other shape it sits centred with gutters on two sides. Chrome that belongs to
 * the playfield — the chat, which floats over its right edge — has to be
 * measured against the canvas, not the stage, or on a wide window it ends up
 * hanging in the black gutter beside the map.
 *
 * Sets, on `stage`, the canvas's inset from each stage edge:
 * `--field-top`, `--field-right`, `--field-bottom`, `--field-left`, plus
 * `--field-width`. All in CSS pixels.
 */
export function trackPlayfield(stage: HTMLElement, canvas: HTMLCanvasElement): void {
  const publish = (): void => {
    const outer = stage.getBoundingClientRect();
    const inner = canvas.getBoundingClientRect();
    const set = (name: string, value: number): void =>
      stage.style.setProperty(name, `${Math.max(0, Math.round(value))}px`);
    set('--field-top', inner.top - outer.top);
    set('--field-right', outer.right - inner.right);
    set('--field-bottom', outer.bottom - inner.bottom);
    set('--field-left', inner.left - outer.left);
    set('--field-width', inner.width);
  };

  // The canvas changes size when Phaser refits it; the stage changes size when
  // the window does or the HUD wraps. Either can move the field.
  const observer = new ResizeObserver(publish);
  observer.observe(stage);
  observer.observe(canvas);
  publish();
}
