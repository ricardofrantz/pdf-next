/// Review panel type size. Quotes and comments follow `--review-size`;
/// the document zoom is a different control.

export const REVIEW_SIZE_STEPS = [10, 11, 12, 13, 15, 17, 20];
export const REVIEW_SIZE_DEFAULT = 12;

export function nearestReviewSize(px) {
  const want = Number(px);
  if (!Number.isFinite(want) || want <= 0) {
    return REVIEW_SIZE_DEFAULT;
  }
  let best = REVIEW_SIZE_DEFAULT;
  let gap = Infinity;
  for (const step of REVIEW_SIZE_STEPS) {
    const d = Math.abs(step - want);
    if (d < gap) {
      best = step;
      gap = d;
    }
  }
  return best;
}

/// Walk one step. A value off the ladder snaps first, then moves.
/// The ends stay put: 10 does not shrink, 20 does not grow.
export function nextReviewSize(current, delta) {
  const size = nearestReviewSize(current);
  const index = REVIEW_SIZE_STEPS.indexOf(size);
  const at = index < 0 ? REVIEW_SIZE_STEPS.indexOf(REVIEW_SIZE_DEFAULT) : index;
  const next = REVIEW_SIZE_STEPS[at + Number(delta)];
  return next === undefined ? size : next;
}
