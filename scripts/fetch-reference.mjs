#!/usr/bin/env node
/**
 * Fetch reference screenshots of the original Scorched Earth (1991) into
 * `e2e/reference/`, for the visual critics to compare against.
 *
 * The images themselves are NOT committed: they are non-free screenshots of a
 * copyrighted game, used on Wikipedia under a fair-use rationale. Shipping
 * copies inside an open-source repository is a licensing problem this project
 * does not need. Anyone (human or agent) who wants them runs:
 *
 *     node scripts/fetch-reference.mjs
 *
 * Dependency-free on purpose — see TECH_STACK.md on minimal dependencies.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'e2e', 'reference');

const WANTED = [
  { title: 'Scorched Earth gameplay.png', as: 'scorched-earth-gameplay.png' },
  { title: 'Scorched Earth title screen.png', as: 'scorched-earth-title-screen.png' },
];

const API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'ScorchedEarthWeb-dev/1.0 (reference capture for visual comparison)';

async function resolveUrl(title) {
  const url = `${API}?action=query&titles=File:${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&format=json`;
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`Lookup failed for "${title}": HTTP ${response.status}`);
  const body = await response.json();
  const page = Object.values(body.query?.pages ?? {})[0];
  const direct = page?.imageinfo?.[0]?.url;
  if (typeof direct !== 'string') throw new Error(`No image URL for "${title}"`);
  return direct;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  for (const item of WANTED) {
    const source = await resolveUrl(item.title);
    const response = await fetch(source, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Download failed for "${item.as}": HTTP ${response.status}`);

    const bytes = Buffer.from(await response.arrayBuffer());
    // Bot-protection pages come back as HTML with a 200. Check the magic bytes
    // rather than trusting the status code.
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) {
      throw new Error(`"${item.as}" did not come back as a PNG — got ${bytes.length} bytes of something else`);
    }

    await writeFile(path.join(OUT_DIR, item.as), bytes);
    console.log(`  ${item.as}  ${bytes.length} bytes  <- ${source.split('?')[0]}`);
  }

  console.log(`\nReference images saved to ${path.relative(ROOT, OUT_DIR)}/`);
}

main().catch((error) => {
  console.error(`\nCould not fetch reference images: ${error.message}`);
  console.error('Critics can still work from the descriptions in e2e/reference/README.md.');
  process.exit(1);
});
