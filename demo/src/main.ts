// import { renderPage } from "./render";
import {
  setupContact,
  setupContactRecovery,
  setupDynamicUrls,
  setupGreeting,
  setupLibraryInfo,
  setupLiveClock,
  setupReveal,
  setupTheme,
} from "./hydrate";

// document.querySelector<HTMLDivElement>("#app")!.innerHTML = renderPage();

/* ---------- hydration ---------- */

// JS is available — remove the nojs gate so the fade-in styles engage.
document.documentElement.removeAttribute("nojs");

const $ = <T extends HTMLElement>(selector: string): T =>
  document.getElementById(selector) as T ||
  document.querySelector<T>(selector) as T;

setupReveal();
setupTheme($("theme-toggle"));
const locale = navigator.language || "en-US";
setupLiveClock($("hero-clock"), null, locale);
setupLiveClock($("demo-time"), $("demo-date"), locale);
setupGreeting($("greet-form"));
const contactForm = $<HTMLFormElement>("contact-form");
setupContact(contactForm);
setupContactRecovery(contactForm);
setupDynamicUrls();
void setupLibraryInfo();
