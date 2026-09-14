/// Human + agent share `{stem}_review.json`. Disk that parses is the store.
/// The panel is a view that also writes. A pending keystroke is kept only when
/// the agent did not touch that review's comment and did not delete it.

export function reconcilePendingComment(pending, diskReviews, savedReviews) {
  if (!pending || !pending.id) {
    return { pending: null, keepDraftId: null };
  }
  const diskList = Array.isArray(diskReviews) ? diskReviews : [];
  const savedList = Array.isArray(savedReviews) ? savedReviews : [];
  const disk = diskList.find((review) => review && review.id === pending.id);
  if (!disk) {
    return { pending: null, keepDraftId: null };
  }
  const saved = savedList.find((review) => review && review.id === pending.id);
  const diskComment = String(disk.comment || '').trim();
  const savedComment = String(saved?.comment || '').trim();
  if (diskComment !== savedComment) {
    return { pending: null, keepDraftId: null };
  }
  const draft = pending.comment == null ? '' : String(pending.comment);
  if (draft.trim() === diskComment) {
    return { pending: null, keepDraftId: null };
  }
  return { pending, keepDraftId: pending.id };
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
