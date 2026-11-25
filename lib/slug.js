/*
  Turns a title and author into a URL-safe slug.

  Slugs are permanent once a book exists — bookmarks and links point at
  book.html?slug=<slug> — so this only has to be good at generating a new one,
  not at renaming. Collisions are resolved with a numeric suffix, which is the
  caller's job because only the caller can query the table.
*/
export function slugify(text) {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip accents: é -> e
    .toLowerCase()
    .replace(/['’]/g, '')             // don't split "Harry's" into "harry-s"
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

// "harry-potter", then "harry-potter-2", and so on.
export async function uniqueSlug(base, exists) {
  const root = slugify(base) || 'book';
  if (!(await exists(root))) return root;
  for (let n = 2; n < 500; n += 1) {
    const candidate = `${root.slice(0, 60)}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error('Could not find a free slug for that title');
}

/*
  The cover is drawn in CSS from three lines of text, so a book added from a
  PDF needs those lines derived from its title. Long titles get split at the
  nearest space to keep each line readable on a 150px card.
*/
export function coverLines(title) {
  const words = String(title || 'Untitled').trim().split(/\s+/).filter(Boolean);
  const LIMIT = 18;

  if (!words.length) return { line1: 'Untitled', line2: '', line3: '' };

  const lines = [];
  let current = '';

  for (const word of words) {
    const next = current ? current + ' ' + word : word;
    if (next.length > LIMIT && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
    if (lines.length === 2) break;
  }
  if (current && lines.length < 3) lines.push(current);

  return {
    line1: lines[0] || 'Untitled',
    line2: lines[1] || '',
    line3: lines[2] || ''
  };
}
