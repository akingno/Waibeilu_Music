// Loaded before styles so a saved light theme does not flash the dark palette.
const themeKey = 'waibeilu-music-theme';
type Theme = 'neon' | 'aero';
let theme: Theme = 'neon';
try {
  if (localStorage.getItem(themeKey) === 'aero') theme = 'aero';
} catch {
  /* Private browsing may disable storage. Switching still works. */
}

function applyTheme(): void {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'aero' ? '#bce9fa' : '#0d0524');
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    const label = theme === 'aero' ? '玻璃蓝绿' : '霓虹紫';
    button.textContent = `主题：${label}`;
    button.setAttribute('aria-label', `切换主题，当前${label}`);
    button.setAttribute('aria-pressed', String(theme === 'aero'));
    button.title = theme === 'aero' ? '切换为霓虹紫' : '切换为 Frutiger Aero 玻璃蓝绿';
  }
}
applyTheme();
document.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      theme = theme === 'aero' ? 'neon' : 'aero';
      applyTheme();
      try {
        localStorage.setItem(themeKey, theme);
      } catch {
        /* Keep the in-memory choice. */
      }
    });
  }
});
window.addEventListener('storage', (event) => {
  if (event.key === themeKey || event.key === null) {
    theme = event.newValue === 'aero' ? 'aero' : 'neon';
    applyTheme();
  }
});
