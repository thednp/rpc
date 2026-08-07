import { getLibraryInfo, getServerTime, sayHi, submitContact } from "./api";

export const setupReveal = () => {
  const elements = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    elements.forEach((el) => el.classList.add("reveal-in"));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("reveal-in");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 },
  );

  elements.forEach((el) => observer.observe(el));
};

export const setupLiveClock = (timeEl: HTMLElement, dateEl: HTMLElement | null, locale: string) => {
  const tick = async () => {
    if (document.visibilityState !== "visible") return;
    const { data } = getServerTime(locale);
    const res = await data;
    timeEl.textContent = res.time;
    if (dateEl) dateEl.textContent = res.date;
  };

  void tick();
  window.setInterval(tick, 5000);
};

const THEME_KEY = "rpc-theme";

export const setupTheme = (toggle: HTMLInputElement) => {
  const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const apply = (theme: "rpc" | "rpc-dark") => {
    toggle.checked = theme === "rpc-dark";
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    themeColorMeta?.setAttribute("content", theme === "rpc-dark" ? "#2d2934" : "#faf9fc");
  };
  
  const stored = localStorage.getItem(THEME_KEY);
  apply(stored === "rpc" || stored === "rpc-dark" ? stored : "rpc-dark");

  toggle.addEventListener("change", () => {
    const newVal = toggle.checked ? "rpc-dark" : "rpc";
    toggle.value = newVal;
    localStorage.setItem(THEME_KEY, newVal);
    document.documentElement.dataset.theme = newVal;
  });
};

export const setupLibraryInfo = async () => {
  try {
    const { data } = getLibraryInfo();
    const info = await data;
    const versionEl = document.getElementById("lib-version");
    if (versionEl) versionEl.textContent = `v${info.version}`;
  } catch {
    // keep the prerendered fallback badge
  }
};

export const setupDynamicUrls = () => {
  const demoUrl = document.getElementById("demo-url");
  if (demoUrl) demoUrl.textContent = `${location.host}/#demo`;
  const curlHost = document.getElementById("curl-host");
  if (curlHost) curlHost.textContent = location.host;
};

export const setupGreeting = (form: HTMLFormElement) => {
  const input = form.querySelector<HTMLInputElement>("#greet-name")!;
  const output = document.getElementById("greet-output")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const spinner = button.querySelector(".loading")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = input.value.trim() || "world";

    output.classList.add("hidden");
    spinner.classList.remove("hidden");
    button.classList.add("btn-disabled");

    const { data } = sayHi(name);
    try {
      const res = await data;
      output.classList.remove("alert-error");
      output.textContent = String(res);
      output.classList.remove("hidden");
    } catch {
      output.textContent = "Request failed — is the server running?";
      output.classList.remove("alert-success");
      output.classList.add("alert-error");
      output.classList.remove("hidden");
    } finally {
      spinner.classList.add("hidden");
      button.classList.remove("btn-disabled");
    }
  });
};

let toastTimer = 0;

const showToast = (text: string, colorClass: string, duration = 4000) => {
  const toast = document.getElementById("toast")!;
  const label = document.getElementById("toast-text")!;
  label.textContent = text;
  toast.classList.remove("hidden", "alert-success", "alert-warning", "alert-error");
  toast.classList.add(colorClass);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.add("hidden"), duration);
};

export const setupContact = (form: HTMLFormElement) => {
  const fields = ["name", "email", "topic", "message"] as const;
  const successBox = document.getElementById("contact-success")!;
  const successText = successBox.querySelector("span")!;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  const spinner = button.querySelector(".loading")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    fields.forEach((field) => {
      const el = form.querySelector<HTMLElement>(`[data-error="${field}"]`);
      if (el) el.textContent = "";
    });
    successBox.classList.add("hidden");
    spinner.classList.remove("hidden");
    button.classList.add("btn-disabled");

    const formData = new FormData(form);

    try {
      const { data } = submitContact(formData);
      const res = await data;

      if (res.status === "ok") {
        form.reset();
        successText.textContent = `Message received — ticket ${res.ticket}. We'll get back to you at ${new Date(
          res.receivedAt!,
        ).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`;
        successBox.classList.remove("hidden");
        showToast("Message sent!", "alert-success");
      } else {
        fields.forEach((field) => {
          const el = form.querySelector<HTMLElement>(`[data-error="${field}"]`);
          const msg = res.errors?.[field]?.[0];
          if (el && msg) el.textContent = msg;
        });
        const firstInvalidField = fields.find((field) => res.errors?.[field]?.[0]);
        if (firstInvalidField) {
          form.querySelector<HTMLElement>(`[name="${firstInvalidField}"]`)?.focus();
        }
        showToast("Check the highlighted fields.", "alert-warning");
      }
    } catch {
      showToast("Couldn't reach the server.", "alert-error");
    } finally {
      spinner.classList.add("hidden");
      button.classList.remove("btn-disabled");
    }
  });
};
