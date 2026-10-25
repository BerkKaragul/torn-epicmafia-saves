// Theme plumbing shared by the boot script and the toggle.
//
// "system" follows the OS; "light"/"dark" pin it. Only the .light class is ever
// applied — dark is the stylesheet's baseline (see globals.css), so if
// JavaScript never runs the app looks exactly as it always has.
//
// An event theme (the server puts e.g. .halloween on <html>) is a dark look of
// its own, so while one is on the light class is never added.

export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "cw-theme";

/** Runs before first paint, inlined into <head>, so there's no flash of dark. */
export const THEME_BOOT_SCRIPT = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});
if(p!=="light"&&p!=="dark"&&p!=="system")p="system";
var light=!document.documentElement.classList.contains("halloween")&&(p==="light"||(p==="system"&&!window.matchMedia("(prefers-color-scheme: dark)").matches));
document.documentElement.classList.toggle("light",light);
}catch(e){}})();`;

/** Page background per theme; also what the browser tints its chrome with. */
const CHROME_COLOR = { light: "#f4f4f5", dark: "#0a0a0a", halloween: "#0e0917" };

/** True while the server has the event theme on. */
export function eventThemeOn(): boolean {
  return document.documentElement.classList.contains("halloween");
}

export function readThemePref(): ThemePref {
  try {
    const p = localStorage.getItem(THEME_KEY);
    if (p === "light" || p === "dark" || p === "system") return p;
  } catch {
    // private mode / blocked storage — fall through to the default
  }
  return "system";
}

export function applyTheme(pref: ThemePref): void {
  const event = eventThemeOn();
  const light =
    !event &&
    (pref === "light" ||
      (pref === "system" && !window.matchMedia("(prefers-color-scheme: dark)").matches));
  document.documentElement.classList.toggle("light", light);

  // The two theme-color metas are declared per prefers-color-scheme, which is
  // wrong the moment someone pins a theme against their OS. Writing the chosen
  // colour into both makes whichever one the browser picks the right answer.
  const color = event ? CHROME_COLOR.halloween : light ? CHROME_COLOR.light : CHROME_COLOR.dark;
  document
    .querySelectorAll('meta[name="theme-color"]')
    .forEach((m) => m.setAttribute("content", color));
}
