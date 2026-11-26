/*
  Reading progress: the percentage the shelf and the reader both show.

  Percent is derived, never stored: page and total are the facts, so a rounded
  number cannot drift out of sync with them.

  Rounding to whole numbers is what the shelf shows, but plain rounding told a
  reader six pages into a 2220-page book that they were 0% in, the same number
  the strip shows before any page is turned. Two rules keep the number honest at
  the ends: any page past the first reads as at least 1%, and 100% is only
  reached on the last page, never rounded up early.
*/

export function percentFor(page, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const at = Number.isFinite(page) ? page : 1;
  if (at >= total) return 100;
  if (at <= 1) return 0;
  return Math.max(1, Math.floor((at / total) * 100));
}

export function withPercent(row) {
  const total = Number.isFinite(row.totalPages) && row.totalPages > 0 ? row.totalPages : null;
  const page = Number.isFinite(row.page) ? row.page : 1;
  return { ...row, percent: percentFor(page, total), finished: Boolean(row.finishedAt) };
}
