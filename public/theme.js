(() => {
  const THEME_KEY = "mall-collector-theme";
  const THEME_LIGHT = "light";
  const THEME_DARK = "dark";
  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const themeButton = document.querySelector("#themeToggleButton");

  if (!themeButton) {
    return;
  }

  const savedTheme = localStorage.getItem(THEME_KEY);

  let currentTheme = savedTheme === THEME_DARK || savedTheme === THEME_LIGHT
    ? savedTheme
    : (systemTheme.matches ? THEME_DARK : THEME_LIGHT);

  const updateThemeButton = (theme) => {
    const isDark = theme === THEME_DARK;
    themeButton.textContent = isDark ? "라이트 모드" : "다크 모드";
    themeButton.setAttribute("aria-label", isDark ? "라이트 모드로 전환" : "다크 모드로 전환");
    themeButton.setAttribute("aria-pressed", String(isDark));
    themeButton.title = isDark ? "라이트 모드로 전환" : "다크 모드로 전환";
  };

  const applyTheme = (theme, persist = false) => {
    currentTheme = theme;
    root.dataset.theme = theme;
    updateThemeButton(theme);

    if (persist) {
      localStorage.setItem(THEME_KEY, theme);
    }
  };

  const resolveSystemTheme = () => (systemTheme.matches ? THEME_DARK : THEME_LIGHT);

  applyTheme(currentTheme);

  themeButton.addEventListener("click", () => {
    const nextTheme = currentTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    applyTheme(nextTheme, true);
  });

  if (systemTheme.addEventListener) {
    systemTheme.addEventListener("change", () => {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored !== THEME_DARK && stored !== THEME_LIGHT) {
        applyTheme(resolveSystemTheme());
      }
    });
  }
})();

