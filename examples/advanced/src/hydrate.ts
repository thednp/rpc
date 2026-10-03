import type { UserFull } from "./api/types.d.ts";
import {
  add,
  getServerTime,
  getUser,
  login,
  logout,
  me,
  profileWithArktype,
  profileWithBuilder,
  profileWithEffect,
  profileWithValibot,
  profileWithZod,
  sayHi,
  selectValidator,
} from "./api/index.ts";
// Client-safe: `types.d.ts` is types plus plain data, with no path to
// `@thednp/rpc/server`. Importing the notes from `./api/validators.ts` instead
// pulled that module — and `node:fs/promises` with it — into the browser.
import type { ProfileInput, ValidatorName } from "./api/types.d.ts";
import { VALIDATOR_NOTES } from "./api/validator-info.ts";
import {
  fieldErrorHint,
  fieldErrors,
  fieldErrorText,
  getClientStub,
  RPCResponseError,
} from "@thednp/rpc/helpers";

// Manual stub for privileged prefix — not in public bundle (public:rpc only).
// In a real multi-page app this `await import` would live only in the /admin
// entry so the admin literal never appears in the public chunk.
// Explicit generics give full inference: input type + return type.
const adminGetUser = getClientStub<string, UserFull>("admin:rpc", "get-user");

export const setupGreeting = async (target: HTMLHeadingElement) => {
  const { data } = sayHi("Jane");
  // target.onmouseenter = () => cancel("Aborted");
  const greeting = await data;
  console.log(`API responded with "${greeting}"`);

  target.innerText = greeting;
};

export const setupForm = (target: HTMLFormElement) => {
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
    // The form submits strings; the schema coerces them, so the client sends the
    // schema's *input* type and the handler receives its *output* type. Built
    // explicitly rather than with `Object.fromEntries`, whose index signature
    // cannot prove `a` and `b` are present. The client no longer hand-serialises
    // a JSON string for the handler to parse.
    const fields = {
      a: String(formData.get("a") ?? ""),
      b: String(formData.get("b") ?? ""),
    };

    ({ data, cancel } = add(fields));
    errorDivA.innerHTML = "";
    errorDivB.innerHTML = "";
    try {
      const result = await data;
      output.textContent = "Result: " + String(result);
    } catch (err) {
      // A rejected input is a `400`, not a `200` carrying `{ error }` as data.
      // The generated client surfaces the body via `RPCResponseError`, so the
      // issue paths and hints the server produced are available here — which is
      // the point of validating at the boundary.
      if (!(err instanceof RPCResponseError)) throw err;
      output.textContent = "Result: Error (" + err.status + ")";
      for (const issue of err.issues ?? []) {
        const target = issue.path === "a"
          ? errorDivA
          : issue.path === "b"
          ? errorDivB
          : null;
        if (!target) continue;
        target.textContent = ` ➜ ${issue.message}`;
        // `fieldErrorHint` falls back to the function-wide `hint` when the issue
        // itself carries none. Reading `issue.hint` directly meant the `add`
        // function's own hint never reached the page, because it is sent once at
        // the top of the body rather than per issue.
        const hint = fieldErrorHint(err, issue.path);
        if (hint) target.title = hint;
      }
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
    const { data } = login({ username: userEl.value, password: passEl.value });
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

/**
 * Renders a failure from any of the three handlers, so a validation rejection
 * looks the same whichever function produced it.
 */
const describeFailure = (err: unknown): string => {
  if (!(err instanceof RPCResponseError)) return `error: ${String(err)}`;
  const issues = Object.entries(fieldErrors(err))
    .map(([path, messages]) => `${path || "(root)"}: ${messages.join("; ")}`)
    .join(" | ");
  const hint = fieldErrorHint(err, "");
  return `Error (${err.status})${issues ? ` — ${issues}` : ""}${
    hint ? `\n      hint: ${hint}` : ""
  }`;
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
    // This handler had no `try`/`catch`, so a rejected input — a blank id, say —
    // became an unhandled rejection and left the output stuck on "Fetching…"
    // forever. The two sibling handlers below both catch, which is why the same
    // failure looked completely different three times on one page.
    try {
      const result = await data;
      publicOutput.textContent = JSON.stringify(result);
    } catch (err) {
      publicOutput.textContent = describeFailure(err);
    }
  });

  adminBtn.addEventListener("click", async () => {
    adminOutput.textContent = "Fetching… (via getClientStub + cookie session)";
    try {
      const { data } = adminGetUser(userId.value);
      const body = await data;
      adminOutput.textContent = `200: ${JSON.stringify(body)}`;
    } catch (err) {
      // `String(e)` produced "RPCResponseError: Fetch error: Bad Request" — the
      // status was in the object and the issues in the body, and both were thrown
      // away. Same shape as the public handler above, on purpose.
      adminOutput.textContent = describeFailure(err);
    }
  });

  // The spam button used to report only the status, and with a blank id every
  // request was a `400` — validation rejects before the handler runs, so the
  // rate limiter inside it never executed and the demo silently stopped
  // demonstrating rate limiting. The summary below separates the two so that
  // cannot look like a working limiter again.
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
    // Grouped rather than a bare list of codes, so "the limiter fired" and "every
    // request was rejected as invalid" cannot be mistaken for one another.
    const tally = statuses.reduce<Record<number, number>>((acc, code) => {
      acc[code] = (acc[code] ?? 0) + 1;
      return acc;
    }, {});
    const summary = Object.entries(tally)
      .map(([code, n]) => `${n}x ${code}`)
      .join(", ");
    spamOutput.textContent = statuses.length
      ? `${summary} — ${statuses.join(", ")}`
      : "no requests";
    if (tally[429] === undefined && tally[200] === undefined) {
      spamOutput.textContent +=
        "  (every request was rejected as invalid, so the rate limiter never ran — use a valid id)";
    }
  });
};

/* ─── Five validators, one option ──────────────────────────────────────────── */

/**
 * Calls the stub for the chosen validator.
 *
 * A `switch` rather than indexing a record of stubs on purpose: the five stubs
 * have five different **Input** types, and calling a union of function types
 * makes TypeScript check the argument against the *intersection* of them — which
 * is arktype's `age: number`, and would reject the string the others accept.
 * The interesting question is per-library, so it is asked per-library.
 */
const runProfile = async (via: ValidatorName, profile: ProfileInput) => {
  switch (via) {
    case "zod":
      return await profileWithZod(profile).data;
    case "arktype":
      // No cast: arktype coerces a string age like the other three, so all four
      // stubs now accept the same `ProfileInput` and the switch is type-clean.
      return await profileWithArktype(profile).data;
    case "effect":
      return await profileWithEffect(profile).data;
    case "builder":
      // No cast either: the builder takes the wire type as-is (`JsonValue`),
      // so the form's `ProfileInput` is assignable straight in.
      return await profileWithBuilder(profile).data;
    default:
      return await profileWithValibot(profile).data;
  }
};

export const setupValidators = (section: HTMLElement) => {
  const picker = section.querySelector(
    "#validator-picker",
  ) as HTMLFieldSetElement;
  const note = section.querySelector("#validator-note") as HTMLElement;
  const form = section.querySelector("#profileForm") as HTMLFormElement;
  const out = section.querySelector("#profile-out") as HTMLOutputElement;
  const issues = section.querySelector("#profile-issues") as HTMLUListElement;
  const fields = {
    name: section.querySelector("#p-name") as HTMLInputElement,
    age: section.querySelector("#p-age") as HTMLInputElement,
    tags: section.querySelector("#p-tags") as HTMLInputElement,
    city: section.querySelector("#p-city") as HTMLInputElement,
    zip: section.querySelector("#p-zip") as HTMLInputElement,
  };

  // The cast is the form's `value` attribute widened to `string`; the radio
  // values are generated from `VALIDATORS` in the SSR template, so they cannot
  // drift from the union. Held in a local so the formatter cannot hoist the
  // assertion off the fallback.
  const selected = (): ValidatorName => {
    const checked = picker.querySelector("input:checked") as HTMLInputElement;
    return (checked?.value ?? "valibot") as ValidatorName;
  };

  // The number field is deliberately `type="text"`: a number input would drop a
  // non-numeric value in the browser, so the "does this validator coerce a
  // string?" case could never be exercised from the page.
  const readProfile = (): ProfileInput => ({
    name: fields.name.value,
    age: fields.age.value,
    tags: fields.tags.value.split(",").map((t) => t.trim()).filter(Boolean),
    address: {
      city: fields.city.value,
      ...(fields.zip.value ? { zip: fields.zip.value } : {}),
    },
  });

  const showNote = () => {
    note.textContent = VALIDATOR_NOTES[selected()];
  };

  const run = async () => {
    const via = selected();
    out.textContent = "…";
    issues.replaceChildren();
    try {
      const result = await runProfile(via, readProfile());
      out.textContent =
        `accepted by ${result.via} — age is ${result.ageType} (${
          JSON.stringify(result.age)
        })`;
    } catch (err) {
      if (!(err instanceof RPCResponseError)) throw err;
      out.textContent = `rejected by ${via} — ${err.status}`;
      // `fieldErrors` reads the normalised issues, so this works for all five
      // libraries without knowing which one produced them.
      for (const path of Object.keys(fieldErrors(err))) {
        const li = document.createElement("li");
        li.textContent = `${path || "(root)"}: ${fieldErrorText(err, path)}`;
        const hint = fieldErrorHint(err, path);
        if (hint) li.title = hint;
        issues.append(li);
      }
    }
  };

  // The radio's own RPC: the server does not need the selection to dispatch
  // (each validator is its own function) but recording it is what makes the
  // choice observable server-side while developing.
  picker.addEventListener("change", async (e) => {
    const target = e.target as HTMLInputElement;
    if (target.name !== "validator") return;
    showNote();
    out.textContent = "…";
    issues.replaceChildren();
    try {
      const { data } = selectValidator({ name: target.value as ValidatorName });
      const { selected: ack } = await data;
      out.textContent = `server selected: ${ack} — press Validate to submit`;
    } catch (err) {
      out.textContent = `selector rejected: ${String(err)}`;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void run();
  });

  showNote();
};
