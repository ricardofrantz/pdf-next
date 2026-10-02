/// Human + agent share `{stem}_review.json`. Disk that parses is the store.
/// The panel is a view that also writes. Conflicting or removed-record drafts
/// remain available for explicit recovery instead of being silently discarded.

export function reconcilePendingComment(pending, diskReviews, savedReviews) {
  if (!pending || !pending.id) {
    return { pending: null, keepDraftId: null };
  }
  const diskList = Array.isArray(diskReviews) ? diskReviews : [];
  const savedList = Array.isArray(savedReviews) ? savedReviews : [];
  const disk = diskList.find((review) => review && review.id === pending.id);
  if (!disk) {
    return { pending, keepDraftId: pending.id, conflict: 'removed' };
  }
  const saved = savedList.find((review) => review && review.id === pending.id);
  const diskComment = String(disk.comment || '').trim();
  const savedComment = String(saved?.comment || '').trim();
  const draft = pending.comment == null ? '' : String(pending.comment);
  const expected = String(pending.expectedComment ?? savedComment).trim();
  if (draft.trim() === diskComment && diskComment === expected) {
    return { pending: null, keepDraftId: null };
  }
  return {
    pending: { ...pending, expectedComment: expected },
    keepDraftId: pending.id,
    conflict: diskComment === expected ? null : 'changed',
  };
}

export function reconcilePendingComments(pending, diskReviews, savedReviews) {
  const next = new Map();
  const conflicts = new Map();
  for (const [id, draft] of pending instanceof Map ? pending : []) {
    const result = reconcilePendingComment(draft, diskReviews, savedReviews);
    if (result.pending) next.set(id, result.pending);
    if (result.conflict) conflicts.set(id, result.conflict);
  }
  return { pending: next, conflicts };
}

/// Map an index in `original.replace(/\s+/g, ' ')` back to `original`.
export function mapCollapsedIndex(original, collapsedIndex) {
  const text = String(original ?? '');
  const want = Number(collapsedIndex);
  if (!Number.isFinite(want) || want <= 0) {
    return 0;
  }
  let oi = 0;
  for (let ci = 0; ci < want; ci += 1) {
    if (oi >= text.length) {
      return text.length;
    }
    if (/\s/.test(text[oi])) {
      while (oi < text.length && /\s/.test(text[oi])) {
        oi += 1;
      }
    } else {
      oi += 1;
    }
  }
  return oi;
}
