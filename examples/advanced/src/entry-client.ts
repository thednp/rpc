import {
  setupAuth,
  setupForm,
  setupGetTime,
  setupGreeting,
  setupMultiPrefix,
} from "./hydrate";

setupGreeting(document.querySelector("h1") as HTMLHeadingElement);
setupForm(document.getElementById("addForm") as HTMLFormElement);
setupGetTime(document.getElementById("timeForm") as HTMLFormElement);
setupAuth(document.getElementById("authSection") as HTMLElement);
setupMultiPrefix(document.getElementById("multiPrefixSection") as HTMLElement);
