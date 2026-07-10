/**
 * Cursor pagination helpers — stable, index-friendly pagination for feeds,
 * messages and vault listings (avoids OFFSET scans at scale).
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function buildCursorQuery(cursor?: string, take = 20) {
  const limit = Math.min(Math.max(take, 1), 50);
  return {
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}

export function toCursorPage<T extends { id: string }>(rows: T[], take = 20): CursorPage<T> {
  const limit = Math.min(Math.max(take, 1), 50);
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
