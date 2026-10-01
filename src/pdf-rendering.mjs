/// Refresh PDF canvases when the window moves to a different display density.
export function watchPdfRendering(viewer) {
  let density = window.devicePixelRatio || 1;
  let query;
  const watchDensity = () => {
    query?.removeEventListener('change', refreshDensity);
    query = window.matchMedia(`(resolution: ${density}dppx)`);
    query.addEventListener('change', refreshDensity);
  };
  const refreshDensity = () => {
    const current = window.devicePixelRatio || 1;
    if (current === density) {
      return;
    }
    density = current;
    watchDensity();
    if (!viewer.pdfDocument) {
      return;
    }
    for (const page of viewer._pages) {
      // Reset first: update alone may reuse a restricted canvas through CSS.
      page.reset();
      page.update({});
    }
    viewer.update();
  };
  watchDensity();
  window.addEventListener('resize', refreshDensity);
}
