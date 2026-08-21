import { add, getServerTime, getUser, login, logout, me, sayHi } from "./api";
import type { UserFull } from "./api/types";
import { getClientStub } from "@thednp/rpc/helpers";
import { getError, isValiError } from "./util/helpers";

// Manual stub for privileged prefix — not in public bundle (public:rpc only).
// In a real multi-page app this `await import` would live only in the /admin
// entry so the admin literal never appears in the public chunk.
// Explicit generics give full inference: args tuple + return type.
const adminGetUser = getClientStub<[string], UserFull>("admin:rpc", "get-user");

export const setupGreeting = async (target: HTMLHeadingElement) => {
  const { data } = sayHi("Jane");
  // target.onmouseenter = () => cancel("Aborted");
  const greeting = await data;
  console.log(`API responded with "${greeting}"`);

  target.innerText = greeting;
};

export const setupForm = async (target: HTMLFormElement) => {
  const cancelBtn = target.querySelector("#cancelBtn") as HTMLOutputElement;

  let data: ReturnType<typeof add>["data"];
  let cancel: (str: string) => void;

  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault();
    cancel?.("Client disconnected");
  });

  target.addEventListener("submit", async (e) => {
    e.preventDefault();
    const formData = new FormData(target);
    const output = target.querySelector("output") as HTMLOutputElement;
    const errorDivA = document.getElementById("error-a") as HTMLDivElement;
    const errorDivB = document.getElementById("error-b") as HTMLDivElement;
    const payload = JSON.stringify(Object.fromEntries(formData.entries()));

    ({ data, cancel } = add(payload));
    const result = await data;

    if (
      typeof result === "object" &&
      "error" in result &&
      isValiError(result.error)
    ) {
      output.textContent = "Result: Error";
      errorDivA.textContent = getError(result.error, "a");
      errorDivB.textContent = getError(result.error, "b");
    } else {
      output.textContent = "Result: " + String(result);
      errorDivA.innerHTML = "";
      errorDivB.innerHTML = "";
    }
  });
};

export const setupGetTime = (target: HTMLFormElement) => {
  const output = target.querySelector("output") as HTMLOutputElement;
  const link = target.querySelector("#time-link") as HTMLAnchorElement;
  const locale = target.querySelector("#locale") as HTMLInputElement;

  target.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { data } = getServerTime(locale.value);
    output.textContent = "Fetching…";
    const result = await data;
    output.textContent = `Time: ${result.time}`;
    link.href = `/public:rpc/get-server-time?args=${
      encodeURIComponent(
        JSON.stringify([locale.value]),
      )
    }`;
    link.target = "_blank";
  });
};

export const setupAuth = (target: HTMLElement) => {
  const form = target.querySelector("#loginForm") as HTMLFormElement;
  const userEl = target.querySelector("#loginUser") as HTMLInputElement;
  const passEl = target.querySelector("#loginPass") as HTMLInputElement;
  const out = target.querySelector("#authOutput") as HTMLOutputElement;
  const logoutBtn = target.querySelector("#logoutBtn") as HTMLButtonElement;
  const meBtn = target.querySelector("#meBtn") as HTMLButtonElement;

  const refreshMe = async () => {
    const { data } = me();
    const res = await data;
    out.textContent = `me: ${JSON.stringify(res)}`;
  };
  // show initial session state
  refreshMe();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    out.textContent = "Logging in…";
    const { data } = login(userEl.value, passEl.value);
    const res = await data;
    out.textContent = `login: ${JSON.stringify(res)}`;
  });

  logoutBtn.addEventListener("click", async () => {
    out.textContent = "Logging out…";
    const { data } = logout();
    const res = await data;
    out.textContent = `logout: ${JSON.stringify(res)}`;
  });

  meBtn.addEventListener("click", refreshMe);
};

export const setupMultiPrefix = (target: HTMLElement) => {
  const userId = target.querySelector("#userId") as HTMLInputElement;
  const publicBtn = target.querySelector("#publicUserBtn") as HTMLButtonElement;
  const publicOutput = target.querySelector(
    "#publicUserOutput",
  ) as HTMLOutputElement;
  const adminBtn = target.querySelector("#adminUserBtn") as HTMLButtonElement;
  const adminOutput = target.querySelector(
    "#adminUserOutput",
  ) as HTMLOutputElement;
  const spamBtn = target.querySelector("#spamBtn") as HTMLButtonElement;
  const spamOutput = target.querySelector("#spamOutput") as HTMLOutputElement;

  publicBtn.addEventListener("click", async () => {
    const { data } = getUser(userId.value);
    publicOutput.textContent = "Fetching…";
    const result = await data;
    publicOutput.textContent = JSON.stringify(result);
  });

  adminBtn.addEventListener("click", async () => {
    adminOutput.textContent = "Fetching… (via getClientStub + cookie session)";
    try {
      const { data } = adminGetUser(userId.value);
      const body = await data;
      adminOutput.textContent = `200: ${JSON.stringify(body)}`;
    } catch (e) {
      adminOutput.textContent = `error: ${String(e)}`;
    }
  });

  spamBtn.addEventListener("click", async () => {
    const statuses: number[] = [];
    const start = Date.now();
    while (Date.now() - start < 3000) {
      const res = await fetch("/public:rpc/get-user", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([userId.value]),
      });
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    spamOutput.textContent = statuses.join(", ");
  });
};
