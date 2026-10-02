import { add, getServerTime, sayHi } from "./api";
import { fieldErrorText, RPCResponseError } from "@thednp/rpc/helpers";

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
    // The object goes over the wire as an object. The previous version
    // stringified it and had the handler `JSON.parse` by hand, because nothing
    // described the input; with a `schema` the stub is typed and the round trip
    // through a string is just a second parse.
    // The cast is the form's actual shape — it has exactly these two inputs,
    // and `Object.fromEntries` cannot know that. The `schema` then checks the
    // values, which is the part a cast cannot do.
    const fields = Object.fromEntries(formData.entries()) as {
      a: string;
      b: string;
    };
    ({ data, cancel } = add(fields));

    // A rejected input is a 400 from the `schema`, so it arrives as a rejection
    // rather than as resolved data. `fieldErrorText` reads the server's
    // normalised issues — no `isValiError` guard, no hand-rolled formatter, and
    // it would read a zod or arktype failure identically.
    try {
      const result = await data;
      output.textContent = "Result: " + String(result);
      errorDivA.textContent = "";
      errorDivB.textContent = "";
    } catch (err) {
      output.textContent = "Result: Error";
      errorDivA.textContent = err instanceof RPCResponseError
        ? fieldErrorText(err, "a")
        : String(err);
      errorDivB.textContent = err instanceof RPCResponseError
        ? fieldErrorText(err, "b")
        : String(err);
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
    link.href = `/__A_server/get-server-time?args=${
      encodeURIComponent(
        JSON.stringify([locale.value]),
      )
    }`;
    link.target = "_blank";
  });
};
