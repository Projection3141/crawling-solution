(() => {
  const THEME_KEY = "mall-collector-theme";
  const THEME_LIGHT = "light";
  const THEME_DARK = "dark";
  const THEME_SYSTEM = "system";
  const VALID_THEMES = new Set([THEME_LIGHT, THEME_DARK, THEME_SYSTEM]);

  const root = document.documentElement;
  const mediaTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const themeButtons = Array.from(
    document.querySelectorAll(".theme-switch [data-theme-choice]"),
  );
  const legacyButton = document.querySelector("#themeToggleButton");

  if (!themeButtons.length && !legacyButton) {
    return;
  }

  const resolveSystemTheme = () => (mediaTheme.matches ? THEME_DARK : THEME_LIGHT);

  const setTheme = (theme, { persist = true } = {}) => {
    const normalized = VALID_THEMES.has(theme) ? theme : THEME_SYSTEM;
    const effectiveTheme =
      normalized === THEME_SYSTEM ? resolveSystemTheme() : normalized;

    root.dataset.theme = effectiveTheme;
    root.dataset.themeChoice = normalized;

    if (persist) {
      localStorage.setItem(THEME_KEY, normalized);
    }

    themeButtons.forEach((button) => {
      const isActive = button.dataset.themeChoice === normalized;
      button.setAttribute("aria-pressed", String(isActive));
    });

    if (legacyButton) {
      const isDark = effectiveTheme === THEME_DARK;
      legacyButton.textContent = isDark ? "라이트 모드" : "다크 모드";
      legacyButton.setAttribute(
        "aria-label",
        isDark ? "라이트 모드로 전환" : "다크 모드로 전환",
      );
      legacyButton.setAttribute("aria-pressed", String(isDark));
      legacyButton.title = isDark ? "라이트 모드로 전환" : "다크 모드로 전환";
    }
  };

  const clickHandler = (event) => {
    const button = event.currentTarget;
    const requestedTheme = button?.dataset?.themeChoice;

    if (requestedTheme) {
      setTheme(requestedTheme);
      return;
    }

    const nextTheme = root.dataset.theme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
    setTheme(nextTheme);
  };

  const initializeFromStorage = () => {
    const savedTheme = localStorage.getItem(THEME_KEY);

    if (themeButtons.length > 0) {
      setTheme(VALID_THEMES.has(savedTheme) ? savedTheme : THEME_LIGHT, {
        persist: false,
      });
      return;
    }

    const validSavedTheme = savedTheme === THEME_DARK || savedTheme === THEME_LIGHT
      ? savedTheme
      : null;
    setTheme(validSavedTheme || resolveSystemTheme(), { persist: false });
  };

  const initialize = () => {
    initializeFromStorage();

    themeButtons.forEach((button) => {
      button.addEventListener("click", clickHandler);
    });

    if (legacyButton) {
      legacyButton.addEventListener("click", clickHandler);
    }

    mediaTheme.addEventListener("change", () => {
      if ((localStorage.getItem(THEME_KEY) || THEME_LIGHT) === THEME_SYSTEM) {
        setTheme(THEME_SYSTEM, { persist: false });
      }
    });
  };

  initialize();
})();
