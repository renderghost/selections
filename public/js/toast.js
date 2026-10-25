let timer;

/** Brief, non-blocking message at the bottom of the page (announced politely). */
export function showToast(message, { duration = 4000 } = {}) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(timer);
  toast.textContent = message;
  toast.hidden = false;
  timer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}
