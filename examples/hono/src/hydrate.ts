import { add, sayHi } from "./api";
import { getError, isValiError } from "./util/helpers";

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
