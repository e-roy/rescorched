/**
 * The three DOM helpers every overlay module needs, and nothing else.
 *
 * `must` is the important one: the markup in `index.html` and the code here are
 * a contract, and a typo in a selector should fail loudly at startup rather than
 * silently produce a panel with a missing readout that nobody notices until a
 * screenshot looks wrong.
 */

export function must<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing required element: ${selector}`);
  return element;
}

export interface ElementOptions {
  className?: string;
  text?: string;
  testId?: string;
  title?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.testId !== undefined) node.dataset['testid'] = options.testId;
  if (options.title !== undefined) node.title = options.title;
  return node;
}
