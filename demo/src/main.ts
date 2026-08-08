// import { renderPage } from "./render";
import {
  setupContact,
  setupDynamicUrls,
  setupGreeting,
  setupLibraryInfo,
  setupLiveClock,
  setupReveal,
  setupTheme,
} from "./hydrate";

// document.querySelector<HTMLDivElement>("#app")!.innerHTML = renderPage();

/* ---------- hydration ---------- */

const $ = <T extends HTMLElement>(selector: string): T =>
  document.getElementById(selector) as T ||
  document.querySelector<T>(selector) as T;

setupReveal();
setupTheme($("theme-toggle"));
const locale = navigator.language || "en-US";
setupLiveClock($("hero-clock"), null, locale);
setupLiveClock($("demo-time"), $("demo-date"), locale);
setupGreeting($("greet-form"));
setupContact($("contact-form"));
setupDynamicUrls();
void setupLibraryInfo();
